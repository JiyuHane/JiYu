import { describe, expect, it } from 'vitest';
import {
    classifyTargetEncryption,
    TARGET_CLASS2_KEY_BYTES,
    TARGET_ENCRYPTION_CLASS_TABLE,
} from '../../src/direct/target-command-policy';

describe('target command encryption classes (static table of build 3.2.35-54395)', () => {
    it('holds the 53 distinct names of the 54-record table', () => {
        const classes = [...TARGET_ENCRYPTION_CLASS_TABLE.values()];
        expect(TARGET_ENCRYPTION_CLASS_TABLE.size).toBe(53);
        expect(classes.filter((value) => value === 0)).toHaveLength(3);
        expect(classes.filter((value) => value === 2)).toHaveLength(50);
    });

    it('leaves the three keep-alive and clock commands unencrypted', () => {
        expect(classifyTargetEncryption('Heartbeat.Alive')).toBe(0);
        expect(classifyTargetEncryption('Heartbeat.Ping')).toBe(0);
        expect(classifyTargetEncryption('Client.CorrectTime')).toBe(0);
    });

    it('puts every pre-session login command on the fixed key', () => {
        for (const command of [
            'wtlogin.trans_emp',
            'wtlogin.login',
            'wtlogin.exchange_emp',
            'wtlogin64.trans_emp',
            'wtlogin64.login',
            'trpc.login.ecdh.EcdhService.SsoKeyExchange',
            'trpc.login.ecdh.EcdhService.SsoNTLoginEasyLogin',
            'trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLogin',
            'trpc.login.ecdh.EcdhService.SsoNTLoginRefreshTicket',
            'trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey',
            'GrayUinPro.Check',
        ]) {
            expect(classifyTargetEncryption(command)).toBe(2);
        }

        expect(TARGET_CLASS2_KEY_BYTES).toBe(16);
    });

    it('defaults unlisted commands to the session-key class', () => {
        for (const command of [
            'trpc.msg.register_proxy.RegisterProxy.SsoInfoSync',
            'trpc.qq_new_tech.status_svc.StatusService.SsoHeartBeat',
            'MessageSvc.PbSendMsg',
            'trpc.msg.olpush.OlPushService.MsgPush',
            'OidbSvcTrpcTcp.0xfe1_2',
            '',
        ]) {
            expect(classifyTargetEncryption(command)).toBe(1);
        }
    });

    it('compares names exactly', () => {
        expect(classifyTargetEncryption('heartbeat.alive')).toBe(1);
        expect(classifyTargetEncryption('Heartbeat.Alive ')).toBe(1);
        expect(classifyTargetEncryption('wtlogin.login\0')).toBe(1);
    });

    it('rejects a non-string command', () => {
        expect(() => classifyTargetEncryption(undefined as unknown as string)).toThrow(TypeError);
    });
});
