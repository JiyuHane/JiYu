/*
 * Jiyu local signing worker: independently written host-ABI placeholder.
 * Original project identity and notices: ../../JIYU_NOTICE.md and ../../LICENSE.
 *
 * A public standalone-loader reference declares this one-pointer, void-return
 * registration entry. The no-op supplies the symbol only; it does not implement
 * N-API or register a QQ host. Its suitability still needs the pinned build's
 * native loading test. No external implementation code is included here.
 */
#if defined(__GNUC__)
__attribute__((visibility("default")))
#endif
void qq_magic_napi_register(void *registration)
{
    (void)registration;
}
