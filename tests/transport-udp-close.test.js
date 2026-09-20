'use strict';

const dgram = require('dgram');
const { expect } = require('chai');
const { GoodweUdpClient } = require('../lib/transport-udp');

// UDP server that swallows every request, so a request stays in flight until the client gives up.
function silentServer() {
    const server = dgram.createSocket('udp4');
    const received = [];
    server.on('message', msg => received.push(msg));
    return new Promise(resolve => {
        server.bind(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
    });
}

describe('GoodweUdpClient.close()', () => {
    let server;
    let received;
    let client;
    let port;

    beforeEach(async () => {
        ({ server, received, port } = await silentServer());
        client = new GoodweUdpClient();
        await client.connectUDP('127.0.0.1', { port });
        client.setTimeout(5000);
    });

    afterEach(() => {
        client.close();
        server.close();
    });

    it('aborts an in-flight request immediately instead of waiting for the timeout', async () => {
        const started = Date.now();
        const pending = client.readHoldingRegisters(35100, 125);
        await new Promise(r => setTimeout(r, 50));
        client.close();

        const err = await pending.then(() => null, e => e);
        expect(err, 'request should reject').to.be.an('error');
        expect(err.closed).to.equal(true);
        expect(Date.now() - started).to.be.below(1000);
    });

    it('does not retry a request that was aborted by close()', async () => {
        const pending = client.readHoldingRegisters(35100, 125);
        await new Promise(r => setTimeout(r, 50));
        client.close();
        await pending.catch(() => {});
        await new Promise(r => setTimeout(r, 100));

        expect(received, 'only the first attempt may reach the wire').to.have.length(1);
    });

    it('rejects new requests after close() with a closed error, without sending anything', async () => {
        client.close();
        const err = await client.readHoldingRegisters(36000, 60).then(() => null, e => e);

        expect(err).to.be.an('error');
        expect(err.closed).to.equal(true);
        expect(err.message).to.not.match(/Socket not open/);
        expect(received).to.have.length(0);
    });

    it('rejects requests that were queued behind the in-flight one', async () => {
        const first = client.readHoldingRegisters(35100, 125);
        const second = client.readHoldingRegisters(36000, 60);
        await new Promise(r => setTimeout(r, 50));
        client.close();

        const [e1, e2] = await Promise.all([
            first.then(() => null, e => e),
            second.then(() => null, e => e),
        ]);
        expect(e1 && e1.closed).to.equal(true);
        expect(e2 && e2.closed).to.equal(true);
        expect(received).to.have.length(1);
    });
});
