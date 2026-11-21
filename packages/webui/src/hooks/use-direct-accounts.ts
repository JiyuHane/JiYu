import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApi } from '@/lib/api';
import { useAppState } from '@/contexts/AppStateContext';
import { useActionFeedback, type ActionFeedbackHandle } from '@/contexts/ActionFeedbackContext';
import { DirectAccountsController } from '@/lib/direct-accounts';

export function useDirectAccounts() {
    const api = useApi();
    const { startAction } = useActionFeedback();
    const { refreshQqList } = useAppState();
    const controller = useMemo(() => {
        const handles = new Map<string, ActionFeedbackHandle>();
        return new DirectAccountsController(
            api.directAccounts,
            (event) => {
                const handle = handles.get(event.id);

                if (event.status === 'running') {
                    if (!handle) {
                        handles.set(
                            event.id,
                            startAction({ title: event.title, detail: event.detail }),
                        );
                    } else {
                        handle.update({ title: event.title, detail: event.detail });
                    }
                } else if (event.status === 'accepted' && event.nextId) {
                    handle?.update({ detail: event.detail });
                    handles.delete(event.id);

                    if (handle) {
                        handles.set(event.nextId, handle);
                    }
                } else if (event.status === 'detached') {
                    handle?.detach();
                    handles.delete(event.id);
                } else {
                    const result = handle ?? startAction({ title: event.title });

                    if (event.status === 'succeeded') {
                        result.succeed({ title: event.title, detail: event.detail });
                    } else {
                        result.fail(event.detail, { title: event.title });
                    }

                    handles.delete(event.id);
                }
            },
            refreshQqList,
        );
    }, [api, startAction, refreshQqList]);
    const state = useSyncExternalStore(
        controller.subscribe,
        controller.getSnapshot,
        controller.getSnapshot,
    );
    useEffect(() => {
        controller.start();
        return controller.stop;
    }, [controller]);
    return { state, controller };
}
