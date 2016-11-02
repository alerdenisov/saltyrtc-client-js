/**
 * Copyright (C) 2016 Threema GmbH / SaltyRTC Contributors
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the `LICENSE.md` file for details.
 */

/// <reference path='../../saltyrtc-client.d.ts' />
/// <reference path='../types/tweetnacl.d.ts' />
/// <reference types='msgpack-lite' />

import * as msgpack from "msgpack-lite";
import { Box } from "../keystore";
import { Cookie } from "../cookie";
import { Nonce } from "../nonce";
import { ProtocolError, ValidationError } from "../exceptions";
import { SignalingError, ConnectionError } from "../exceptions";
import { concat, byteToHex } from "../utils";
import { isResponderId } from "./helpers";
import { HandoverState } from "./handoverstate";
import { CloseCode, explainCloseCode } from "../closecode";
import SignalingState = saltyrtc.SignalingState;
import {Server, Peer} from "../peers";

/**
 * Signaling base class.
 */
export abstract class Signaling implements saltyrtc.Signaling {
    static SALTYRTC_SUBPROTOCOL = 'v0.saltyrtc.org';
    static SALTYRTC_ADDR_UNKNOWN = 0x00;
    static SALTYRTC_ADDR_SERVER = 0x00;
    static SALTYRTC_ADDR_INITIATOR = 0x01;

    // WebSocket
    protected host: string;
    protected port: number;
    protected protocol: string = 'wss';
    protected ws: WebSocket = null;
    protected pingInterval: number;

    // Msgpack
    protected msgpackOptions: msgpack.BufferOptions = {
        codec: msgpack.createCodec({binarraybuffer: true}),
    };

    // Connection state
    protected state: saltyrtc.SignalingState = 'new';
    public handoverState = new HandoverState();

    // Main class
    protected client: saltyrtc.SaltyRTC;

    // Tasks
    protected tasks: saltyrtc.Task[];
    public task: saltyrtc.Task = null;

    // Server information
    protected server = new Server();

    // Our keys
    protected permanentKey: saltyrtc.KeyStore;
    protected sessionKey: saltyrtc.KeyStore = null;

    // Peer trusted key or auth token
    protected peerTrustedKey: Uint8Array = null;
    protected authToken: saltyrtc.AuthToken = null;

    // TODO: Server trusted key

    // Signaling
    public role: saltyrtc.SignalingRole = null;
    protected logTag: string = 'Signaling:';
    protected address: number = Signaling.SALTYRTC_ADDR_UNKNOWN;

    /**
     * Create a new signaling instance.
     */
    constructor(client: saltyrtc.SaltyRTC, host: string, port: number, tasks: saltyrtc.Task[], pingInterval: number,
                permanentKey: saltyrtc.KeyStore, peerTrustedKey?: Uint8Array) {
        this.client = client;
        this.permanentKey = permanentKey;
        this.host = host;
        this.port = port;
        this.tasks = tasks;
        this.pingInterval = pingInterval;
        if (peerTrustedKey !== undefined) {
            this.peerTrustedKey = peerTrustedKey;
        }
        this.handoverState.onBoth = () => {
            this.client.emit({type: 'handover'});
        };
    }

    /**
     * Register a signaling state change.
     *
     * TODO: Regular methods would probably be better.
     */
    public setState(newState: saltyrtc.SignalingState): void {
        this.state = newState;

        // Notify listeners
        this.client.emit({type: 'state-change', data: newState});
        this.client.emit({type: 'state-change:' + newState});
    }

    /**
     * Return current state.
     */
    public getState(): saltyrtc.SignalingState {
        return this.state;
    }

    /**
     * Return the public permanent key as Uint8Array.
     */
    public get permanentKeyBytes(): Uint8Array {
        return this.permanentKey.publicKeyBytes;
    }

    /**
     * Return the auth token as Uint8Array, or null if no auth token is initialized.
     */
    public get authTokenBytes(): Uint8Array {
        if (this.authToken !== null) {
            return this.authToken.keyBytes;
        }
        return null;
    }

    /**
     * Return the peer permanent key as Uint8Array.
     */
    public get peerPermanentKeyBytes(): Uint8Array {
        return this.getPeerPermanentKey();
    }

    /**
     * Encode msgpack data.
     */
    protected msgpackEncode(data: Object) {
        return msgpack.encode(data, this.msgpackOptions);
    }

    /**
     * Decode msgpack data.
     */
    protected msgpackDecode(data: Uint8Array) {
        return msgpack.decode(data, this.msgpackOptions);
    }

    /**
     * Open a connection to the signaling server and do the handshake.
     */
    public connect(): void {
        this.resetConnection();
        this.initWebsocket();
    }

    /**
     * Disconnect from the signaling server.
     */
    public disconnect(closeCode: number): void {
        // Close WebSocket instance
        if (this.ws !== null) {
            console.debug(this.logTag, 'Disconnecting WebSocket');
            this.ws.close(closeCode);
        }
        this.ws = null;

        // TODO: Do we need to close the task dc?

        this.setState('closed');

        // Notify subscribers
        this.client.emit({type: 'connection-closed', data: closeCode});
    }

    /**
     * Return connection path for websocket.
     */
    protected abstract getWebsocketPath(): string;

    /**
     * Open a new WebSocket connection to the signaling server.
     */
    protected initWebsocket() {
        const url = this.protocol + '://' + this.host + ':' + this.port + '/';
        const path = this.getWebsocketPath();
        this.ws = new WebSocket(url + path, Signaling.SALTYRTC_SUBPROTOCOL);

        // Set binary type
        this.ws.binaryType = 'arraybuffer';

        // Set event handlers
        this.ws.addEventListener('open', this.onOpen);
        this.ws.addEventListener('error', this.onError);
        this.ws.addEventListener('close', this.onClose);
        this.ws.addEventListener('message', this.onMessage);

        // Store connection on instance
        this.setState('ws-connecting');
        console.debug(this.logTag, 'Opening WebSocket connection to', url + path);
    }

    /**
     * WebSocket onopen handler.
     */
    protected onOpen = (ev: Event) => {
        console.info(this.logTag, 'Opened connection');
        this.setState('server-handshake');
    };

    /**
     * WebSocket onerror handler.
     */
    protected onError = (ev: ErrorEvent) => {
        console.error(this.logTag, 'General WebSocket error', ev);
        // TODO: Do we need to update the state here?
        // TODO: Do we need to emit this event more often?
        this.client.emit({type: 'connection-error', data: ev});
    };

    /**
     * WebSocket onclose handler.
     */
    protected onClose = (ev: CloseEvent) => {
        if (ev.code === CloseCode.Handover) {
            console.info(this.logTag, 'Closed WebSocket connection due to handover');
        } else {
            console.info(this.logTag, 'Closed WebSocket connection');
            this.setState('closed');
            const log = (reason) => console.error(this.logTag, 'Server closed connection:', reason);
            switch (ev.code) {
                case CloseCode.GoingAway:
                    log('Server is being shut down');
                    break;
                case CloseCode.NoSharedSubprotocol:
                    log('No shared sub-protocol could be found');
                    break;
                case CloseCode.PathFull:
                    log('Path full (no free responder byte)');
                    break;
                case CloseCode.ProtocolError:
                    log('Protocol error');
                    break;
                case CloseCode.InternalError:
                    log('Internal server error');
                    break;
                case CloseCode.DroppedByInitiator:
                    log('Dropped by initiator');
                    break;
            }
        }
    };

    protected onMessage = (ev: MessageEvent) => {
        console.debug(this.logTag, 'New ws message (' + (ev.data as ArrayBuffer).byteLength + ' bytes)');

        if (this.handoverState.peer) {
            console.error(this.logTag, 'Protocol error: Received WebSocket message from peer ' +
                'even though it has already handed over to task.');
            this.resetConnection(CloseCode.ProtocolError);
            return;
        }

        try {
            // Parse buffer
            const box: saltyrtc.Box = Box.fromUint8Array(new Uint8Array(ev.data), Nonce.TOTAL_LENGTH);

            // Parse nonce
            const nonce: Nonce = Nonce.fromArrayBuffer(box.nonce.buffer);

            // Dispatch message
            switch (this.getState()) {
                case 'server-handshake':
                    this.onServerHandshakeMessage(box, nonce);
                    break;
                case 'peer-handshake':
                    this.onPeerHandshakeMessage(box, nonce);
                    break;
                case 'task':
                    this.onSignalingMessage(box, nonce);
                    break;
                default:
                    console.warn(this.logTag, 'Received message in', this.getState(), 'signaling state. Ignoring.');
            }
        } catch(e) {
            if (e instanceof SignalingError) {
                console.error(this.logTag, 'Signaling error: ' + explainCloseCode(e.closeCode));
                // Send close message if client-to-client handshake has been completed
                if (this.state === 'task') {
                    this.sendClose(e.closeCode);
                }
                // Close connection
                this.resetConnection(e.closeCode);
            } else if (e instanceof ConnectionError) {
                console.warn(this.logTag, 'Connection error. Resetting connection.');
                this.resetConnection(CloseCode.InternalError);
            }
            throw e;
        }
    };

    /**
     * Handle messages received during server handshake.
     *
     * @throws SignalingError
     */
    protected onServerHandshakeMessage(box: saltyrtc.Box, nonce: Nonce): void {
        // Decrypt if necessary
        let payload: Uint8Array;
        if (this.server.handshakeState === 'new') {
            // The very first message is unencrypted
            payload = box.data;
        } else {
            // Later, they're encrypted with our permanent key and the server key
            payload = this.permanentKey.decrypt(box, this.server.sessionKey);
        }

        // Handle message
        const msg: saltyrtc.Message = this.decodeMessage(payload, 'server handshake');
        switch (this.server.handshakeState) {
            case 'new':
                // Expect server-hello
                if (msg.type !== 'server-hello') {
                    throw new ProtocolError('Expected server-hello message, but got ' + msg.type);
                }
                console.debug(this.logTag, 'Received server-hello');
                // TODO: Validate nonce
                this.handleServerHello(msg as saltyrtc.messages.ServerHello, nonce);
                this.sendClientHello();
                this.sendClientAuth();
                break;
            case 'hello-sent':
                throw new ProtocolError('Received ' + msg.type + ' message before sending client-auth');
            case 'auth-sent':
                // Expect server-auth
                if (msg.type !== 'server-auth') {
                    throw new ProtocolError('Expected server-auth message, but got ' + msg.type);
                }
                console.debug(this.logTag, "Received server-auth");
                // TODO: Validate nonce
                this.handleServerAuth(msg as saltyrtc.messages.ServerAuth, nonce);
                break;
            case 'done':
                throw new SignalingError(CloseCode.InternalError,
                    'Received server handshake message even though server handshake state is set to \'done\'');
            default:
                throw new SignalingError(CloseCode.InternalError,
                    'Unknown server handshake state: ' + this.server.handshakeState);
        }

        // Check if we're done yet
        if (this.server.handshakeState as string === 'done') {
            this.setState('peer-handshake');
            console.debug(this.logTag, 'Server handshake done');
            this.initPeerHandshake();
        }
    }

    /**
     * Handle messages received during peer handshake.
     */
    protected abstract onPeerHandshakeMessage(box: saltyrtc.Box, nonce: Nonce): void;

    /**
     * Handle messages received from peer *after* the handshake is done.
     */
    protected onSignalingMessage(box: saltyrtc.Box, nonce: Nonce): void {
        // TODO: Validate nonce?
        console.debug('Message received');
        if (nonce.source === Signaling.SALTYRTC_ADDR_SERVER) {
            this.onSignalingServerMessage(box);
        } else {
            // TODO: Do we need to validate the source id or does that happen deeper down?
            let decrypted: Uint8Array;
            try {
                decrypted = this.decryptFromPeer(box);
            } catch (e) {
                if (e === 'decryption-failed') {
                    console.warn(this.logTag, 'Could not decrypt peer message from', byteToHex(nonce.source));
                    return;
                } else { throw e; }
            }
            this.onSignalingPeerMessage(decrypted);
        }
    }

    protected onSignalingServerMessage(box: saltyrtc.Box): void {
        const msg: saltyrtc.Message = this.decryptServerMessage(box);
        // TODO: Catch problems?

        if (msg.type === 'send-error') {
            this.handleSendError(msg as saltyrtc.messages.SendError);
        } else {
            console.warn(this.logTag, 'Invalid server message type:', msg.type);
        }
    }

    /**
     * Signaling message received from peer *after* the handshake is done.
     *
     * @param decrypted Decrypted bytes from the peer.
     * @throws SignalingError if the message is invalid.
     */
    public onSignalingPeerMessage(decrypted: Uint8Array): void {
        let msg: saltyrtc.Message = this.decodeMessage(decrypted);

        if (msg.type === 'close') {
            console.debug('Received close');
            // TODO: Handle
        } else if (msg.type === 'restart') {
            console.debug(this.logTag, 'Received restart');
            this.handleRestart(msg as saltyrtc.messages.Restart);
        } else if (this.task !== null && this.task.getSupportedMessageTypes().indexOf(msg.type) !== -1) {
            console.debug(this.logTag, 'Received', msg.type, '[' + this.task.getName() + ']');
            this.task.onTaskMessage(msg as saltyrtc.messages.TaskMessage);
        } else {
            // TODO: Check if message is a task message
            console.warn(this.logTag, 'Received message with invalid type from peer:', msg.type);
        }
    }

    /**
     * Handle an incoming server-hello message.
     */
    protected handleServerHello(msg: saltyrtc.messages.ServerHello, nonce: Nonce): void {
        // Update server instance
        this.server.sessionKey = new Uint8Array(msg.key);
        this.server.cookiePair.theirs = nonce.cookie;
    }

    /**
     * Send a client-hello message to the server.
     */
    protected abstract sendClientHello(): void;

    /**
     * Send a client-auth message to the server.
     */
    protected sendClientAuth(): void {
        const message: saltyrtc.messages.ClientAuth = {
            type: 'client-auth',
            your_cookie: this.server.cookiePair.theirs.asArrayBuffer(),
            subprotocols: [Signaling.SALTYRTC_SUBPROTOCOL],
            ping_interval: this.pingInterval,
        };
        const packet: Uint8Array = this.buildPacket(message, this.server);
        console.debug(this.logTag, 'Sending client-auth');
        this.ws.send(packet);
        this.server.handshakeState = 'auth-sent';
    }

    /**
     * Handle an incoming server-auth message.
     */
    protected abstract handleServerAuth(msg: saltyrtc.messages.ServerAuth, nonce: Nonce): void;

    /**
     * Initialize the peer handshake.
     */
    protected abstract initPeerHandshake(): void;

    /**
     * Handle an incoming restart message.
     */
    protected handleRestart(msg: saltyrtc.messages.Restart): void {
        throw new ProtocolError('Restart messages not yet implemented');
    }

    /**
     * Handle an incoming send-error message.
     */
    protected handleSendError(msg: saltyrtc.messages.SendError): void {
        throw new ProtocolError('Send error messages not yet implemented');
    }

    /**
     * Send a close message to the peer.
     */
    public sendClose(reason: number): void {
        const message: saltyrtc.messages.Close = {
            type: 'close',
            reason: reason,
        };
        const packet: Uint8Array = this.buildPacket(message, this.getPeer());
        console.debug(this.logTag, 'Sending close');
        this.ws.send(packet);
    }

    /**
     * Handle an incoming close message.
     */
    protected handleClose(msg: saltyrtc.messages.Close): void {
        console.warn(this.logTag, 'Received close message. Reason:',
            msg.reason, '(' + explainCloseCode(msg.reason) + ')');

        // Notify the task
        this.task.close(msg.reason);

        // Reset signaling
        this.resetConnection(CloseCode.GoingAway);
    }

    /**
     * Validate destination and optionally source of nonce.
     *
     * Possible exceptions:
     * - bad-nonce-source
     * - bad-nonce-destination
     */
    protected validateNonce(nonce: Nonce, destination?: number, source?: number): void {
        // Validate destination
        if (destination !== undefined && nonce.destination !== destination) {
            console.error(this.logTag, 'Nonce destination is', nonce.destination, 'but we\'re', this.address);
            throw 'bad-nonce-destination';
        }

        // Validate source
        if (source !== undefined && nonce.source !== source) {
            console.error(this.logTag, 'Nonce source is', nonce.source, 'but should be', source);
            throw 'bad-nonce-source';
        }

        // TODO: sequence & overflow & cookie
    }

    /**
     * Validate a repeated cookie in an incoming Auth / Server-Auth message.
     *
     * If it does not equal our own cookie, throw a ProtocolError.
     */
    protected validateRepeatedCookie(peer: Peer, repeatedCookieBytes: ArrayBuffer): void {
        const repeatedCookie = Cookie.fromArrayBuffer(repeatedCookieBytes);
        if (!repeatedCookie.equals(peer.cookiePair.ours)) {
            console.debug(this.logTag, 'Their cookie:', repeatedCookie.bytes);
            console.debug(this.logTag, 'Our cookie:', peer.cookiePair.ours.bytes);
            throw new ProtocolError('Peer repeated cookie does not match our cookie');
        }
    }

    /**
     * Decode the decrypted message and validate type.
     *
     * If decoding fails, throw a `ProtocolError`.
     *
     * If `enforce` is set to true and the actual type does not match the
     * expected type, throw a `ProtocolError`.
     *
     * @throws ProtocolError
     */
    protected decodeMessage(data: Uint8Array, expectedType?: saltyrtc.messages.MessageType | string,
                            enforce=false): saltyrtc.Message {
        // Decode
        const msg = this.msgpackDecode(data) as saltyrtc.Message;

        if (msg.type === undefined) {
            throw new ProtocolError('Malformed ' + expectedType + ' message: Failed to decode msgpack data.');
        }

        // Validate type
        if (enforce && expectedType !== undefined && msg.type !== expectedType) {
            throw new ProtocolError('Invalid ' + expectedType + ' message, bad type: ' + msg);
        }

        return msg;
    }

    /**
     * Build and return a packet containing the specified message for the
     * specified receiver.
     *
     * Returns encrypted msgpacked bytes, ready to send.
     *
     * May throw a `ProtocolError`.
     */
    protected buildPacket(message: saltyrtc.Message, receiver: Peer, encrypt=true): Uint8Array {
        // Choose proper sequence number
        let csn: saltyrtc.NextCombinedSequence;
        try {
            csn = receiver.csnPair.ours.next();
        } catch (e) {
            throw new ProtocolError("CSN overflow: " + (e as Error).message);
        }

        // Create nonce
        const nonce = new Nonce(receiver.cookiePair.ours,
            csn.overflow, csn.sequenceNumber, this.address, receiver.id);
        const nonceBytes = new Uint8Array(nonce.toArrayBuffer());

        // Encode message
        const data: Uint8Array = this.msgpackEncode(message);

        // Non encrypted messages can be created by concatenation
        if (encrypt === false) {
            return concat(nonceBytes, data);
        }

        // Otherwise, encrypt packet
        // TODO: Use polymorphism using peer object
        let box;
        if (receiver.id === Signaling.SALTYRTC_ADDR_SERVER) {
            box = this.encryptHandshakeDataForServer(data, nonceBytes);
        } else if (receiver.id === Signaling.SALTYRTC_ADDR_INITIATOR || isResponderId(receiver.id)) {
            box = this.encryptHandshakeDataForPeer(receiver.id, message.type, data, nonceBytes);
        } else {
            throw new ProtocolError('Bad receiver byte: ' + receiver);
        }
        return box.toUint8Array();
    }

    /**
     * Encrypt data for the server.
     */
    protected encryptHandshakeDataForServer(payload: Uint8Array, nonceBytes: Uint8Array): saltyrtc.Box {
        return this.permanentKey.encrypt(payload, nonceBytes, this.server.sessionKey);
    }

    /**
     * Encrypt data for the specified peer.
     */
    protected abstract encryptHandshakeDataForPeer(receiver: number, messageType: string,
                                                   payload: Uint8Array, nonceBytes: Uint8Array): saltyrtc.Box;

    /**
     * Get the peer instance.
     *
     * May return null if peer is not yet set.
     */
    protected abstract getPeer(): Peer;

    /**
     * Get the session key of the peer.
     *
     * May return null if peer is not yet set.
     */
    protected abstract getPeerSessionKey(): Uint8Array;

    /**
     * Get the permanent key of the peer.
     *
     * May return null if peer is not yet set.
     */
    protected abstract getPeerPermanentKey(): Uint8Array;

    /**
     * Decrypt data from the peer using the session keys.
     */
    public decryptData(box: saltyrtc.Box): ArrayBuffer {
        const decryptedBytes = this.sessionKey.decrypt(box, this.getPeerSessionKey());

        // We need to return an ArrayBuffer, but we can't directly return
        // `decryptedBytes.buffer` because the `Uint8Array` could be a view
        // into the underlying buffer. Therefore we return a view into the
        // ArrayBuffer instead.
        const start = decryptedBytes.byteOffset;
        const end = start + decryptedBytes.byteLength;
        return decryptedBytes.buffer.slice(start, end);
    }

    /**
     * Reset/close the connection.
     *
     * - Close WebSocket if still open
     * - Set `this.ws` to `null`
     * - Set `this.status` to `new`
     * - Reset the server combined sequence
     */
    public resetConnection(reason?: number): void {
        // Notify listeners
        if (reason !== undefined) {
            this.client.emit({type: 'connection-closed', data: reason});
        }

        // Close WebSocket instance
        if (this.ws !== null) {
            console.debug(this.logTag, 'Disconnecting WebSocket (close code ' + reason + ')');
            this.ws.close(reason);
        }
        this.ws = null;

        // Reset
        this.server = new Server();
        this.handoverState.reset();
        this.setState('new');
        console.debug('Connection reset');

        // TODO: Close dc
    }


    /**
     * Initialize the task with the task data sent by the peer.
     * Set it as the current task.
     *
     * @param task The task instance.
     * @param data The task data provided by the peer.
     * @throws SignalingError
     */
    protected initTask(task: saltyrtc.Task, data: Object): void {
        try {
            task.init(this, data);
        } catch (e) {
            if (e instanceof ValidationError) {
                throw new ProtocolError("Peer sent invalid task data");
            } throw e;
        }
        this.task = task;
    }

    /**
     * Decrypt and decode a P2P message, encrypted with the session key.
     *
     * When `convertErrors` is set to `true`, decryption errors will be
     * converted to a `ProtocolError`.
     *
     * TODO: Separate cookie / csn per data channel.
     */
    public decryptPeerMessage(box: saltyrtc.Box, convertErrors=true): saltyrtc.Message {
        try {
            const decrypted = this.sessionKey.decrypt(box, this.getPeerSessionKey());
            return this.decodeMessage(decrypted, 'peer');
        } catch(e) {
            if (convertErrors === true && e === 'decryption-failed') {
                const nonce = Nonce.fromArrayBuffer(box.nonce.buffer);
                throw new ProtocolError('Could not decrypt peer message from ' + byteToHex(nonce.source));
            } else { throw e; }
        }
    }

    /**
     * Decrypt and decode a server message.
     */
    public decryptServerMessage(box: saltyrtc.Box): saltyrtc.Message {
        try {
            const decrypted = this.permanentKey.decrypt(box, this.server.sessionKey);
            return this.decodeMessage(decrypted, 'server');
        } catch(e) {
            if (e === 'decryption-failed') {
                throw new ProtocolError('Could not decrypt server message');
            } else { throw e; }
        }
    }

    /**
     * Send binary data through the signaling channel.
     *
     * @throws ConnectionError if message cannot be sent due to a bad signaling state.
     */
    private send(payload: Uint8Array): void {
        if (['server-handshake', 'peer-handshake', 'task'].indexOf(this.state) === -1) {
            console.error('Trying to send message, but connection state is', this.state);
            throw new ConnectionError("Bad signaling state, cannot send message");
        }

        if (this.handoverState.local === false) {
            this.ws.send(payload);
        } else {
            this.task.sendSignalingMessage(payload);
        }
    }

    /**
     * Send a task message through the signaling channel.
     * @param msg The message to be sent.
     * @throws SignalingError
     */
    public sendTaskMessage(msg: saltyrtc.messages.TaskMessage): void {
        const receiver = this.getPeer();
        if (receiver === null) {
            throw new SignalingError(CloseCode.InternalError, 'No peer address could be found');
        }
        const packet = this.buildPacket(msg, receiver);
        this.send(packet);
    }

    /**
     * Encrypt data for the peer using the session key and the specified nonce.
     *
     * This method should primarily be used by tasks.
     */
    public encryptForPeer(data: Uint8Array, nonce: Uint8Array): saltyrtc.Box {
        return this.sessionKey.encrypt(data, nonce, this.getPeerSessionKey());
    }

    /**
     * Decrypt data from the peer using the session key.
     *
     * This method should primarily be used by tasks.
     */
    public decryptFromPeer(box: saltyrtc.Box): Uint8Array {
        try {
            return this.sessionKey.decrypt(box, this.getPeerSessionKey());
        } catch (e) {
            if (e === 'decryption-failed') {
                // This could only happen if the session keys are somehow broken.
                // If that happens, something went massively wrong.
                if (this.state === 'task') {
                    this.sendClose(CloseCode.InternalError);
                }
                this.resetConnection(CloseCode.InternalError);
                return null;
            } else {
                throw e;
            }
        }
    }

}