/**
 * Test utils.
 *
 * Copyright (C) 2016 Threema GmbH / SaltyRTC Contributors
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the `LICENSE.md` file for details.
 */

export function sleep(milliseconds: number): Promise<{}> {
    return new Promise(function(resolve) {
        window.setTimeout(resolve, milliseconds);
    });
}

