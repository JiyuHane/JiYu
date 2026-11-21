export class DirectLoginError extends Error {
    constructor(
        readonly code: string,
        options?: ErrorOptions,
    ) {
        super(`Direct QQ login: ${code}`, options);
        this.name = 'DirectLoginError';
    }
}
