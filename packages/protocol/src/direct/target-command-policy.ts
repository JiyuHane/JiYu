/**
 * Target-static command policy of Linux QQ 3.2.35-54395 (wrapper.node SHA-256
 * dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328).
 *
 * The MSF packet codec classifies an outgoing command by name. The lookup at
 * 0x6667140 walks 54 records of 24 bytes at 0x902ac70..0x902b180 (relocated
 * name pointer, name length, class) comparing length and bytes; a name that is
 * not listed yields class 1 (`mov al, 1` at 0x66671b4). One name,
 * `GrayUinPro.Check`, occurs twice with the same class, so the table below has
 * 53 distinct names.
 *
 * The class selects the body encryption of the service frame: 0 writes the body
 * unencrypted, 2 uses the 16 zero bytes at 0xfd5bb0 as the QQ-TEA key
 * (referenced at 0x666c3e0 outbound and 0x666c619 inbound), and 1 uses the
 * session key held by the request context. These are the same three flag
 * values the reference service frame in `service-frame.ts` uses.
 *
 * This is a static reading of one build. It does not establish that a server
 * accepts a frame built with these classes, and it says nothing about which
 * commands carry a security signature.
 */
export type TargetEncryptionClass = 0 | 1 | 2;

const UNENCRYPTED = ['Heartbeat.Alive', 'Heartbeat.Ping', 'Client.CorrectTime'] as const;

const ZERO_KEY = [
    'GrayUinPro.Check',
    'ConfigService.ClientReq',
    'PhSigLcId.Check',
    'login.auth',
    'wtlogin.name2uin',
    'wtlogin.login',
    'wtlogin.exchange_emp',
    'wtlogin.trans_emp',
    'wtlogin.fastlogin',
    'account.RequestVerifyWTLogin_emp',
    'account.RequestReBindMblWTLogin_emp',
    'wtlogin64.exchange_emp',
    'wtlogin64.trans_emp',
    'wtlogin64.login',
    'wtlogin64.name2uin',
    'ConnAuthSvr.get_app_info_emp',
    'ConnAuthSvr.get_auth_api_list_emp',
    'ConnAuthSvr.sdk_auth_api_emp',
    'loginfb.register',
    'trpc.o3.mobile_security.MobileSecurity.SsoCheckSwitch',
    'trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey',
    'trpc.o3.ecdh_access.EcdhAccess.SsoSecureAccess',
    'trpc.login.ecdh.EcdhService.SsoKeyExchange',
    'trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLogin',
    'trpc.login.ecdh.EcdhService.SsoNTLoginEasyLogin',
    'trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLoginNewDevice',
    'trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLoginUnusualDevice',
    'trpc.login.ecdh.EcdhService.SsoNTLoginEasyLoginUnusualDevice',
    'trpc.login.ecdh.EcdhService.SsoNTLoginAuthCodeLogin',
    'trpc.login.ecdh.EcdhService.SsoNTLoginOptimusLogin',
    'trpc.login.ecdh.EcdhService.SsoNTLoginGetSaltList',
    'trpc.login.ecdh.EcdhService.SsoNTLoginAuthNewDevice',
    'trpc.login.ecdh.EcdhService.SsoNTLoginCheckA1List',
    'trpc.login.ecdh.EcdhService.SsoNTLoginGetSms',
    'trpc.login.ecdh.EcdhService.SsoNTLoginCheckSms',
    'trpc.login.ecdh.EcdhService.SsoNTLoginCheckGateWayCode',
    'trpc.login.ecdh.EcdhService.SsoNTLoginCheckThirdCode',
    'trpc.login.ecdh.EcdhService.SsoNTLoginRefreshTicket',
    'trpc.login.ecdh.EcdhService.SsoNTLoginRefreshA2',
    'trpc.login.ecdh.EcdhService.SsoOIDB0x913a',
    'trpc.group_pro.configdistribution.ConfigDistributionSvr.SsoGetNoLoginConfig',
    'trpc.login.ecdh.EcdhService.SsoOIDB0x916a',
    'trpc.login.ecdh.EcdhService.SsoOIDB0x916b',
    'trpc.login.ecdh.EcdhService.SsoOIDB0x916c',
    'trpc.login.ecdh.EcdhService.SsoOIDB0x916d',
    'trpc.login.ecdh.EcdhService.SsoOIDB0x9689',
    'trpc.login.ecdh.EcdhService.SsoNTLoginRapidLogin',
    'OidbSvcTrpcTcp.0x955f_1',
    'OidbSvcTrpcTcp.0x9560_1',
    'OidbSvcTrpcTcp.0x9689_1',
] as const;

/** Every command the target lists explicitly; any other name is class 1. */
export const TARGET_ENCRYPTION_CLASS_TABLE: ReadonlyMap<string, 0 | 2> = new Map<string, 0 | 2>([
    ...UNENCRYPTED.map((name): [string, 0] => [name, 0]),
    ...ZERO_KEY.map((name): [string, 2] => [name, 2]),
]);

/** Length of the fixed class-2 key; all of its bytes are zero in this build. */
export const TARGET_CLASS2_KEY_BYTES = 16;

/**
 * Class the target assigns to a command name. The comparison is exact and
 * case-sensitive, as in the target's length-and-bytes compare.
 */
export function classifyTargetEncryption(command: string): TargetEncryptionClass {
    if (typeof command !== 'string') {
        throw new TypeError('command must be a string');
    }

    return TARGET_ENCRYPTION_CLASS_TABLE.get(command) ?? 1;
}
