import type React from "react";
import { useTranslation } from "react-i18next";
import type { WebsiteCrawlNotice } from "@/queries/useKnowledgeQueries";

function noticeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const WebsiteCrawlNotices: React.FC<{ notices: WebsiteCrawlNotice[] }> = ({
  notices,
}) => {
  const { t } = useTranslation();
  return (
    <>
      {notices.map((crawl) => {
        const host = noticeHost(crawl.origin);
        const message = !crawl.rulesUnreachable
          ? t("ai.knowledge.list.banner.skippedByRules", {
              count: crawl.skippedByRules,
              host,
            })
          : crawl.hasPages
            ? t("ai.knowledge.list.banner.rulesUnreachableNoNewPages", { host })
            : t("ai.knowledge.list.banner.rulesUnreachable", { host });
        return (
          <div
            key={crawl.origin}
            className="p-3 rounded-lg bg-amber-400/5 border border-amber-400/10"
          >
            <p className="text-xs text-amber-400/80">{message}</p>
          </div>
        );
      })}
    </>
  );
};

export default WebsiteCrawlNotices;
