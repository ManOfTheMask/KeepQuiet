import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import express, { Request, Response } from 'express';
import session from 'express-session';
import { GridFSBucket, ObjectId } from 'mongodb';

import ChatController from '../Controllers/ChatController';
import UserController from '../Controllers/UserController';
import ConversationModel from '../Models/ConversationModel';
import MessageModel from '../Models/MessageModel';
import GroupConversationModel from '../Models/GroupConversationModel';
import GroupMessageModel from '../Models/GroupMessageModel';
import UserModel from '../Models/UserModel';

let mongoServer: MongoMemoryServer;

const ATTACHMENT_BUCKET_NAME = 'chat_attachments';
const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ENCRYPTED_ATTACHMENT_SIZE_BYTES = MAX_ATTACHMENT_SIZE_BYTES + (32 * 1024 * 1024);

function getAttachmentBucket(): GridFSBucket {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not ready.');
  return new GridFSBucket(db, { bucketName: ATTACHMENT_BUCKET_NAME });
}

function safeAttachmentFilename(fileName: string): string {
  const cleaned = fileName
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\/]/g, '_')
    .trim();
  if (!cleaned) return 'attachment.bin';
  return cleaned.slice(0, 255);
}

function parseAttachmentUploadHeaders(req: Request) {
  const rawName = req.header('x-file-name');
  const rawMime = req.header('x-file-mime');
  const rawSize = req.header('x-file-size');

  if (!rawName || !rawSize) {
    throw new Error('Attachment headers x-file-name and x-file-size are required.');
  }

  let decodedName = rawName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    decodedName = rawName;
  }

  const sizeBytes = Number(rawSize);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('x-file-size must be a positive number.');
  }
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error('File size exceeds the 5GB limit.');
  }

  return {
    fileName: safeAttachmentFilename(decodedName),
    mimeType: (rawMime?.trim() || 'application/octet-stream').slice(0, 200),
    sizeBytes,
  };
}

async function uploadEncryptedAttachmentToGridFS(
  req: Request,
  senderId: string,
  conversationType: 'dm' | 'group',
  conversationId: string,
  headers: { fileName: string; mimeType: string; sizeBytes: number },
) {
  const bucket = getAttachmentBucket();
  const uploadStream = bucket.openUploadStream(headers.fileName, {
    contentType: 'application/octet-stream',
    metadata: {
      senderId,
      conversationType,
      conversationId,
      originalFileName: headers.fileName,
      originalMimeType: headers.mimeType,
      originalSize: headers.sizeBytes,
      encrypted: true,
    },
  });

  let encryptedSizeBytes = 0;

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      encryptedSizeBytes += chunk.length;
      if (encryptedSizeBytes > MAX_ENCRYPTED_ATTACHMENT_SIZE_BYTES) {
        uploadStream.destroy(new Error('Encrypted payload exceeds the allowed size limit.'));
        reject(new Error('Encrypted payload exceeds the allowed size limit.'));
        return;
      }
      uploadStream.write(chunk);
    });

    req.on('error', reject);
    req.on('end', () => uploadStream.end());
    uploadStream.on('finish', () => resolve());
    uploadStream.on('error', reject);
  });

  if (encryptedSizeBytes === 0) {
    throw new Error('Attachment body is empty.');
  }

  return {
    attachmentId: uploadStream.id.toString(),
    fileName: headers.fileName,
    mimeType: headers.mimeType,
    sizeBytes: headers.sizeBytes,
    encryptedSizeBytes,
  };
}

async function isUserAuthorizedForConversationScope(
  userId: string,
  conversationType: 'dm' | 'group',
  conversationId: string,
): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return false;
  }

  const uid = new mongoose.Types.ObjectId(userId);
  const cid = new mongoose.Types.ObjectId(conversationId);

  if (conversationType === 'dm') {
    const conv = await ConversationModel.findById(cid).lean();
    if (!conv) return false;
    return (conv.participants as any[]).some((p: any) => p.equals(uid));
  }

  const group = await GroupConversationModel.findById(cid).lean();
  if (!group) return false;
  return (group.members as any[]).some((m: any) => m.userId.equals(uid));
}

async function findLiveAttachmentReference(fileId: ObjectId): Promise<{ conversationType: 'dm' | 'group'; conversationId: string } | null> {
  const dmRef = await MessageModel.findOne({ 'attachment.fileId': fileId, deletedAt: null }, { conversationId: 1 }).lean();
  if (dmRef?.conversationId) {
    return { conversationType: 'dm', conversationId: dmRef.conversationId.toString() };
  }
  const groupRef = await GroupMessageModel.findOne({ 'attachment.fileId': fileId, deletedAt: null }, { groupId: 1 }).lean();
  if (groupRef?.groupId) {
    return { conversationType: 'group', conversationId: groupRef.groupId.toString() };
  }
  return null;
}

async function cleanupAttachmentIfOrphaned(fileId: ObjectId): Promise<void> {
  const liveRef = await findLiveAttachmentReference(fileId);
  if (liveRef) return;
  const bucket = getAttachmentBucket();
  try {
    await bucket.delete(fileId);
  } catch {
    // ignore
  }
}

function buildAppForUser(userId: string) {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    (req as any).session = { authenticated: true, userId };
    next();
  });

  app.post('/chat/:conversationId/attachments/upload', async (req: Request, res: Response) => {
    try {
      const user = (req as any).session.userId as string;
      const conversationId = req.params.conversationId;
      const allowed = await isUserAuthorizedForConversationScope(user, 'dm', conversationId);
      if (!allowed) {
        res.status(403).json({ success: false, message: 'Unauthorized.' });
        return;
      }

      const headers = parseAttachmentUploadHeaders(req);
      const attachment = await uploadEncryptedAttachmentToGridFS(req, user, 'dm', conversationId, headers);
      res.json({ success: true, attachment });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.get('/attachments/:attachmentId', async (req: Request, res: Response) => {
    try {
      const user = (req as any).session.userId as string;
      const attachmentId = req.params.attachmentId;
      if (!ObjectId.isValid(attachmentId)) {
        res.status(400).json({ success: false, message: 'Invalid attachment id.' });
        return;
      }

      const bucket = getAttachmentBucket();
      const fileId = new ObjectId(attachmentId);
      const files = await bucket.find({ _id: fileId }).toArray();
      if (!files.length) {
        res.status(404).json({ success: false, message: 'Attachment not found.' });
        return;
      }

      const file = files[0];
      const metadata = (file.metadata ?? {}) as {
        conversationType?: 'dm' | 'group';
        conversationId?: string;
        originalFileName?: string;
        originalMimeType?: string;
        originalSize?: number;
      };

      const liveReference = await findLiveAttachmentReference(fileId);
      if (!liveReference) {
        await cleanupAttachmentIfOrphaned(fileId);
        res.status(404).json({ success: false, message: 'Attachment not found.' });
        return;
      }

      if (!metadata.conversationType || !metadata.conversationId) {
        res.status(400).json({ success: false, message: 'Attachment metadata is invalid.' });
        return;
      }

      if (metadata.conversationType !== liveReference.conversationType || metadata.conversationId !== liveReference.conversationId) {
        res.status(400).json({ success: false, message: 'Attachment metadata mismatch.' });
        return;
      }

      const allowed = await isUserAuthorizedForConversationScope(user, metadata.conversationType, metadata.conversationId);
      if (!allowed) {
        res.status(403).json({ success: false, message: 'Unauthorized.' });
        return;
      }

      const safeName = safeAttachmentFilename(metadata.originalFileName ?? file.filename ?? 'attachment.bin');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pgp"`);
      res.setHeader('X-Attachment-Name', encodeURIComponent(safeName));
      res.setHeader('X-Attachment-Mime', metadata.originalMimeType ?? 'application/octet-stream');
      res.setHeader('X-Attachment-Size', String(metadata.originalSize ?? 0));

      const downloadStream = bucket.openDownloadStream(fileId);
      downloadStream.on('error', () => res.status(500).end());
      downloadStream.pipe(res);
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  return app;
}

describe('Attachment routes integration', () => {
  let userA: any;
  let userB: any;
  let userC: any;
  let dmConversation: any;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: 'test' });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
      GroupConversationModel.deleteMany({}),
      GroupMessageModel.deleteMany({}),
    ]);

    const bucket = getAttachmentBucket();
    try {
      await mongoose.connection.db?.collection(`${ATTACHMENT_BUCKET_NAME}.files`).deleteMany({});
      await mongoose.connection.db?.collection(`${ATTACHMENT_BUCKET_NAME}.chunks`).deleteMany({});
    } catch {
      // ignore
    }

    userA = await UserController.createUser('att-key-a', 'AttAlice', 'att-armored-a');
    userB = await UserController.createUser('att-key-b', 'AttBob', 'att-armored-b');
    userC = await UserController.createUser('att-key-c', 'AttCarol', 'att-armored-c');
    dmConversation = await ChatController.getOrCreateConversation(userA._id.toString(), userB._id.toString());
  });

  it('uploads encrypted bytes and allows authorized participant download', async () => {
    const appA = buildAppForUser(userA._id.toString());

    const encryptedPayload = Buffer.from('encrypted-bytes-123');
    const uploadRes = await request(appA)
      .post(`/chat/${dmConversation._id.toString()}/attachments/upload`)
      .set('X-File-Name', encodeURIComponent('report.pdf'))
      .set('X-File-Mime', 'application/pdf')
      .set('X-File-Size', '42')
      .set('Content-Type', 'application/octet-stream')
      .send(encryptedPayload);

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.success).toBe(true);
    expect(uploadRes.body.attachment?.attachmentId).toBeTruthy();

    await ChatController.sendMessage(dmConversation._id.toString(), userA._id.toString(), '', uploadRes.body.attachment);

    const appB = buildAppForUser(userB._id.toString());
    const downloadRes = await request(appB)
      .get(`/attachments/${uploadRes.body.attachment.attachmentId}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(downloadRes.status).toBe(200);
    expect(Buffer.from(downloadRes.body).toString()).toBe(encryptedPayload.toString());
  });

  it('rejects upload for non-participant', async () => {
    const appC = buildAppForUser(userC._id.toString());
    const res = await request(appC)
      .post(`/chat/${dmConversation._id.toString()}/attachments/upload`)
      .set('X-File-Name', encodeURIComponent('secret.bin'))
      .set('X-File-Mime', 'application/octet-stream')
      .set('X-File-Size', '10')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('1234567890'));

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 and removes orphan file after message soft-delete', async () => {
    const appA = buildAppForUser(userA._id.toString());

    const uploadRes = await request(appA)
      .post(`/chat/${dmConversation._id.toString()}/attachments/upload`)
      .set('X-File-Name', encodeURIComponent('orphan.txt'))
      .set('X-File-Mime', 'text/plain')
      .set('X-File-Size', '11')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('hello world'));

    const sent = await ChatController.sendMessage(dmConversation._id.toString(), userA._id.toString(), '', uploadRes.body.attachment);
    await ChatController.deleteMessage(sent._id.toString(), userA._id.toString());

    const appB = buildAppForUser(userB._id.toString());
    const downloadRes = await request(appB).get(`/attachments/${uploadRes.body.attachment.attachmentId}`);

    expect(downloadRes.status).toBe(404);

    const files = await getAttachmentBucket().find({ _id: new ObjectId(uploadRes.body.attachment.attachmentId) }).toArray();
    expect(files.length).toBe(0);
  });
});
