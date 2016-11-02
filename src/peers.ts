/**
 * Copyright (C) 2016 Threema GmbH / SaltyRTC Contributors
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the `LICENSE.md` file for details.
 */

import {CombinedSequencePair} from "./csn";
import {KeyStore} from "./keystore";
import {byteToHex} from "./utils";
import {CookiePair} from "./cookie";

/**
 * Base class for peers (initiator or responder).
 */
export abstract class Peer {
    protected _id: number;
    public permanentKey: Uint8Array | null;
    public sessionKey: Uint8Array | null;
    protected _csnPair = new CombinedSequencePair();
    protected _cookiePair: saltyrtc.CookiePair;

    constructor(id: number, cookiePair?: saltyrtc.CookiePair) {
        this._id = id;
        if (cookiePair === undefined) {
            this._cookiePair = new CookiePair();
        } else {
            this._cookiePair = cookiePair;
        }
    }

    public get id(): number {
        return this._id;
    }

    public get hexId(): string {
        return byteToHex(this._id);
    }

    public get csnPair(): CombinedSequencePair {
        return this._csnPair;
    }

    public get cookiePair(): saltyrtc.CookiePair {
        return this._cookiePair;
    }
}

/**
 * Information about the initiator. Used by responder during handshake.
 */
export class Initiator extends Peer {
    public static ID = 0x01;

    public connected = false;
    public handshakeState: 'new' | 'token-sent' | 'key-sent' | 'key-received' | 'auth-sent' | 'auth-received' = 'new';

    constructor(permanentKey: Uint8Array) {
        super(Initiator.ID);
        this.permanentKey = permanentKey;
    }
}

/**
 * Information about a responder. Used by initiator during handshake.
 */
export class Responder extends Peer {
    public keyStore = new KeyStore();
    public handshakeState: 'new' | 'token-received' | 'key-received' | 'key-sent' | 'auth-received' | 'auth-sent' = 'new';

    constructor(id: number) {
        super(id);
    }
}

/**
 * Information about the server.
 */
export class Server extends Peer {
    public static ID = 0x00;

    public handshakeState: 'new' | 'hello-sent' | 'auth-sent' | 'done' = 'new';

    constructor() {
        super(Server.ID);
    }
}