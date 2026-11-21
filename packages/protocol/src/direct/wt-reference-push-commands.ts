// Fixed inbound notification services, not a prefix or caller-extensible allow-list.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Message/PushMessageService.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Services/System/InfoSyncPushService.cs#L10-L19
// https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Services/System/PushParamsService.cs#L9-L17
// Acceptance still requires the owner's D2, account, key-state and raw-frame policies.
export function isWtReferencePushCommand(command: string): boolean {
    switch (command) {
        case 'trpc.msg.olpush.OlPushService.MsgPush':
        case 'trpc.msg.register_proxy.RegisterProxy.InfoSyncPush':
        case 'trpc.msg.register_proxy.RegisterProxy.PushParams':
        case 'ConfigPushSvc.PushReq':
            return true;
        default:
            return false;
    }
}

export function isWtReferencePushProtocol(command: string, protocol: number): boolean {
    // Linux configuration and message pushes were observed with both response protocols.
    // Only these exact names accept 13; D2, owner and raw-frame checks remain separate.
    return (
        (protocol === 12 && isWtReferencePushCommand(command)) ||
        (protocol === 13 &&
            (command === 'ConfigPushSvc.PushReq' ||
                command === 'trpc.msg.olpush.OlPushService.MsgPush'))
    );
}
