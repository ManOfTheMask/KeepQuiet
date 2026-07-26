export type OnTrackCallback = (peerId: string, stream: MediaStream) => void;
export type OnIceCandidateCallback = (peerId: string, candidate: RTCIceCandidateInit) => void;
export type OnConnectionStateCallback = (peerId: string, state: RTCPeerConnectionState) => void;

export class CallManager {
    private peers = new Map<string, RTCPeerConnection>();
    private remoteStreams = new Map<string, MediaStream>();
    private candidateBuffer = new Map<string, RTCIceCandidateInit[]>();
    private remoteDescSet = new Set<string>();
    private localStream: MediaStream | null = null;
    private cameraTrack: MediaStreamTrack | null = null;
    private screenTrack: MediaStreamTrack | null = null;
    private stoppingScreenShare = false;
    private readonly iceServers: RTCIceServer[];

    private readonly onTrack: OnTrackCallback;
    private readonly onIceCandidate: OnIceCandidateCallback;
    private readonly onConnectionState: OnConnectionStateCallback;

    constructor(params: {
        onTrack: OnTrackCallback;
        onIceCandidate: OnIceCandidateCallback;
        onConnectionState: OnConnectionStateCallback;
        iceServers?: RTCIceServer[];
    }) {
        this.onTrack = params.onTrack;
        this.onIceCandidate = params.onIceCandidate;
        this.onConnectionState = params.onConnectionState;
        this.iceServers = params.iceServers ?? [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];
    }

    async ensureLocalMedia(video = true, audio = true): Promise<MediaStream> {
        if (this.localStream) return this.localStream;
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ video, audio });
            this.cameraTrack = this.localStream.getVideoTracks()[0] ?? null;
            return this.localStream;
        } catch (err) {
            const name = (err as DOMException).name;
            if (name === 'NotAllowedError' || name === 'PermissionDeniedError') throw err;
            if (video && audio) {
                this.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
                this.cameraTrack = this.localStream.getVideoTracks()[0] ?? null;
                return this.localStream;
            }
            throw err;
        }
    }

    private replaceOutgoingVideoTrack(nextTrack: MediaStreamTrack | null) {
        for (const pc of this.peers.values()) {
            const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
            if (!sender) continue;
            sender.replaceTrack(nextTrack).catch(() => undefined);
        }
    }

    async startScreenShare(onEnded?: () => void): Promise<MediaStreamTrack> {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const nextTrack = display.getVideoTracks()[0] ?? null;
        if (!nextTrack) throw new Error('No display track available.');

        this.screenTrack = nextTrack;
        this.replaceOutgoingVideoTrack(this.screenTrack);

        if (this.localStream) {
            for (const t of this.localStream.getVideoTracks()) this.localStream.removeTrack(t);
            this.localStream.addTrack(this.screenTrack);
        }

        this.screenTrack.onended = async () => {
            if (this.stoppingScreenShare) return;
            this.screenTrack = null;
            await this.restoreCameraTrack().catch(() => undefined);
            if (onEnded) onEnded();
        };

        return this.screenTrack;
    }

    private async restoreCameraTrack(): Promise<MediaStreamTrack | null> {
        if (!this.cameraTrack || this.cameraTrack.readyState !== 'live') {
            const cam = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            this.cameraTrack = cam.getVideoTracks()[0] ?? null;
        }

        this.replaceOutgoingVideoTrack(this.cameraTrack);
        if (this.localStream) {
            for (const t of this.localStream.getVideoTracks()) this.localStream.removeTrack(t);
            if (this.cameraTrack) this.localStream.addTrack(this.cameraTrack);
        }

        return this.cameraTrack;
    }

    async stopScreenShare(): Promise<MediaStreamTrack | null> {
        if (!this.screenTrack) return this.localStream?.getVideoTracks()[0] ?? null;
        const track = this.screenTrack;
        this.screenTrack = null;
        this.stoppingScreenShare = true;

        track.onended = null;
        if (track.readyState === 'live') track.stop();

        try {
            return await this.restoreCameraTrack();
        } finally {
            this.stoppingScreenShare = false;
        }
    }

    isScreenSharing(): boolean {
        return !!this.screenTrack;
    }

    private createPeer(peerId: string, replaceExisting = false): RTCPeerConnection {
        const existing = this.peers.get(peerId);
        if (existing && !replaceExisting) return existing;

        if (existing && replaceExisting) {
            existing.close();
            this.peers.delete(peerId);
            this.remoteStreams.delete(peerId);
            this.candidateBuffer.delete(peerId);
            this.remoteDescSet.delete(peerId);
        }

        const pc = new RTCPeerConnection({ iceServers: this.iceServers });

        if (this.localStream) {
            for (const track of this.localStream.getTracks()) {
                pc.addTrack(track, this.localStream);
            }
        }

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.onIceCandidate(peerId, event.candidate.toJSON());
            }
        };

        pc.ontrack = (event) => {
            const stream = event.streams[0] ?? this.remoteStreams.get(peerId) ?? new MediaStream();
            if (!event.streams[0]) stream.addTrack(event.track);
            this.remoteStreams.set(peerId, stream);
            this.onTrack(peerId, stream);
        };

        pc.onconnectionstatechange = () => {
            this.onConnectionState(peerId, pc.connectionState);
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                this.peers.delete(peerId);
            }
        };

        this.peers.set(peerId, pc);
        return pc;
    }

    async createOffer(peerId: string): Promise<RTCSessionDescriptionInit> {
        let pc = this.createPeer(peerId);
        if (pc.signalingState !== 'stable') {
            pc = this.createPeer(peerId, true);
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return offer;
    }

    async receiveOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        const pc = this.createPeer(peerId, true);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await this.flushCandidates(peerId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        return answer;
    }

    async receiveAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
        const pc = this.peers.get(peerId);
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.flushCandidates(peerId);
    }

    async receiveIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
        if (!this.remoteDescSet.has(peerId)) {
            const buffered = this.candidateBuffer.get(peerId) ?? [];
            buffered.push(candidate);
            this.candidateBuffer.set(peerId, buffered);
            return;
        }
        const pc = this.peers.get(peerId);
        if (!pc) return;
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    private async flushCandidates(peerId: string): Promise<void> {
        this.remoteDescSet.add(peerId);
        const buffered = this.candidateBuffer.get(peerId) ?? [];
        this.candidateBuffer.delete(peerId);
        const pc = this.peers.get(peerId);
        if (!pc) return;

        for (const candidate of buffered) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    toggleMute(): boolean {
        const track = this.localStream?.getAudioTracks()[0];
        if (!track) return false;
        track.enabled = !track.enabled;
        return !track.enabled;
    }

    toggleCam(): boolean {
        const track = this.localStream?.getVideoTracks()[0];
        if (!track) return true;
        track.enabled = !track.enabled;
        return !track.enabled;
    }

    getLocalStream(): MediaStream | null {
        return this.localStream;
    }

    getRemoteStream(peerId: string): MediaStream | undefined {
        return this.remoteStreams.get(peerId);
    }

    closePeer(peerId: string): void {
        this.peers.get(peerId)?.close();
        this.peers.delete(peerId);
        this.remoteStreams.delete(peerId);
        this.candidateBuffer.delete(peerId);
        this.remoteDescSet.delete(peerId);
    }

    closeAll(): void {
        for (const pc of this.peers.values()) pc.close();
        this.peers.clear();
        this.remoteStreams.clear();
        this.candidateBuffer.clear();
        this.remoteDescSet.clear();
        this.cameraTrack = null;
        this.screenTrack = null;
        if (this.localStream) {
            for (const track of this.localStream.getTracks()) track.stop();
        }
        this.localStream = null;
    }
}
