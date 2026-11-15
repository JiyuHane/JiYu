import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { MiniAppShareReq, MiniAppShareResp } from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { MiscApi } from '../src/bridge/apis/misc';
import type { BridgeContext } from '../src/bridge/bridge-context';

const command = 'LightAppSvc.mini_app_share.AdaptShareInfo';
const json = JSON.stringify({
    ver: '1.0',
    prompt: 'prefix\ufeffinside',
    config: { forward: true },
    appName: 'synthetic.app',
    appView: 'detail',
    metaData: { title: 'example' },
});

function responseWithJson(jsonStr: string): Buffer {
    return Buffer.from(protobuf_encode<MiniAppShareResp>({ body: { jsonStr } }));
}

function fakeApi(result: SendPacketResult) {
    const sendRawPacket = vi.fn(async (_command: string, _body: Uint8Array) => result);
    const ctx = { sendRawPacket } as unknown as BridgeContext;

    return { api: new MiscApi(ctx), sendRawPacket };
}

function success(responseData: Buffer): SendPacketResult {
    return { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
}

function invoke(api: MiscApi) {
    return api.getMiniAppArk('bili', 'title', 'description', 'pic', 'jump');
}

function expectSingleRequest(sendRawPacket: ReturnType<typeof fakeApi>['sendRawPacket']) {
    expect(sendRawPacket).toHaveBeenCalledOnce();
    const [actualCommand, requestBytes] = sendRawPacket.mock.calls[0]!;
    expect(actualCommand).toBe(command);
    expect(protobuf_decode<MiniAppShareReq>(requestBytes)).toMatchObject({
        sdkVersion: 'V1_PC_MINISDK_99.99.99_1_APP_A',
        body: {
            appid: '1109937557',
            title: 'title',
            desc: 'description',
            picUrl: 'pic',
            jumpUrl: 'jump',
        },
    });
}

describe('MiniAppShareResp protobuf JSON boundary', () => {
    it('preserves the leading BOM in the decoded protobuf string itself', () => {
        const withBom = `\ufeff${json}`;
        const encoded = responseWithJson(withBom);

        expect(protobuf_decode<MiniAppShareResp>(encoded).body?.jsonStr).toBe(withBom);
    });

    it('returns exactly the same ark for ordinary and single-BOM JSON', async () => {
        const ordinary = fakeApi(success(responseWithJson(json)));
        const withBom = fakeApi(success(responseWithJson(`\ufeff${json}`)));
        const ordinaryResult = await invoke(ordinary.api);
        const bomResult = await invoke(withBom.api);

        expect(ordinaryResult).toEqual({
            data: {
                ver: '1.0',
                prompt: 'prefix\ufeffinside',
                config: { forward: true },
                app: 'synthetic.app',
                view: 'detail',
                meta: { title: 'example' },
                miniappShareOrigin: 3,
                miniappOpenRefer: '10002',
            },
        });
        expect(bomResult).toEqual(ordinaryResult);
        expectSingleRequest(ordinary.sendRawPacket);
        expectSingleRequest(withBom.sendRawPacket);
    });

    it.each([
        ['double BOM', `\ufeff\ufeff${json}`],
        ['malformed JSON', '{invalid'],
        ['single BOM followed by malformed JSON', '\ufeff{invalid'],
    ])('rejects %s with SyntaxError', async (_label, input) => {
        const fixture = fakeApi(success(responseWithJson(input)));

        await expect(invoke(fixture.api)).rejects.toBeInstanceOf(SyntaxError);
        expectSingleRequest(fixture.sendRawPacket);
    });

    it.each([
        ['empty response body', Buffer.from(protobuf_encode<MiniAppShareResp>({}))],
        ['empty JSON string', responseWithJson('')],
        ['single BOM only', responseWithJson('\ufeff')],
    ])('preserves the empty JSON error for %s', async (_label, responseData) => {
        const fixture = fakeApi(success(responseData));

        await expect(invoke(fixture.api)).rejects.toThrow('mini app share json empty');
        expectSingleRequest(fixture.sendRawPacket);
    });

    it.each([
        [
            'reported error',
            {
                success: false,
                gotResponse: true,
                errorCode: 1,
                errorMessage: 'synthetic failure',
                responseData: null,
            },
            'synthetic failure',
        ],
        [
            'missing data',
            {
                success: true,
                gotResponse: true,
                errorCode: 0,
                errorMessage: '',
                responseData: null,
            },
            'get mini app ark failed',
        ],
    ] as const)('preserves the packet error for %s', async (_label, result, message) => {
        const fixture = fakeApi(result);

        await expect(invoke(fixture.api)).rejects.toThrow(message);
        expectSingleRequest(fixture.sendRawPacket);
    });
});
