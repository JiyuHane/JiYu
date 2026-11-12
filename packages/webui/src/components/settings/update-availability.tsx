import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { APP_VERSION } from '@/types';

export const JIYU_REPO_URL = 'https://github.com/JiyuHane/Jiyu';

/** The current runtime has no Jiyu update source or versioning scheme. */
export function UpdateAvailability() {
    return (
        <div className="flex flex-col items-start gap-3 px-5 py-4">
            <p className="text-sm">
                当前版本 <code className="font-mono">v{APP_VERSION}</code>
            </p>
            <p className="text-sm text-muted-foreground">
                当前霁羽在线更新尚未启用，自有发行源和版本方案尚未确定。保存的更新来源配置会保留，但目前不生效。请查看项目发行页面了解后续进展。
            </p>
            <Button asChild variant="outline" size="sm">
                <a href={`${JIYU_REPO_URL}/releases`} target="_blank" rel="noreferrer noopener">
                    <ExternalLink className="size-4" /> 查看发行页面
                </a>
            </Button>
        </div>
    );
}
