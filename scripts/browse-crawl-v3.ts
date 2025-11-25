import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "url";
import { Stagehand, type Page } from "@browserbasehq/stagehand";
import { z } from "zod";
import { createOutputDir, sanitizeForFilename, savePageContent } from "../src/file-utils";

const defaultConfig = {
  startUrl: "https://finance.yahoo.com/",
  goal: `Extract up to 10 main entry links from headline, top stories, or trending sections.`,
  maxDepth: 1,
  sleepMs: 2000,
};

export interface CrawlConfig {
  goal: string;
  maxDepth: number;
  sleepMs: number;
}

export const CrawlPageSchema = z.object({
  pageType: z
    .enum(["content", "entry", "blocked", "other", "content-assumed"])
    .describe(
      "ONLY use 'content', 'entry', 'blocked', or 'other'. DO NOT use 'content-assumed' (reserved for system use). Classify based on the page's PRIMARY purpose: 'content' = page with a main article/post to read (e.g., news article, blog post, documentation); 'entry' = index/listing page with links to browse (e.g., homepage, category page, search results); 'blocked' = page is inaccessible (login required, paywall, error, CAPTCHA); 'other' = doesn't fit other categories. If the page has substantial written content as its main focus, choose 'content' regardless of navigation menus."
    ),
  blockedReason: z
    .enum(["auth", "paywall", "error", "captcha", "rate-limit", "geo-blocked", "unknown"])
    .optional()
    .describe(
      "ONLY set if pageType is 'blocked'. Specify why the page is blocked: 'auth' = login/signup required; 'paywall' = subscription/payment required; 'error' = 404/403/500/error page; 'captcha' = bot detection; 'rate-limit' = too many requests; 'geo-blocked' = region restricted; 'unknown' = blocked but reason unclear. Omit this field entirely for non-blocked pages."
    ),
  nextLinks: z
    .array(
      z.object({
        url: z.string().url(),
        text: z.string(),
        linkType: z
          .enum(["content", "entry"])
          .describe(
            "Predict the type of page this link leads to: 'content' = likely an article/post with main content to read; 'entry' = likely an index/listing page with more links to browse"
          ),
      })
    )
    .describe(
      "Links to explore based on the navigation goal. Return empty array if this is a content page with no relevant links to explore, or if the page is blocked."
    ),
});

export type CrawlPageData = z.infer<typeof CrawlPageSchema>;

export interface PageSnapshot {
  url: string;
  depth: number;
  timestamp: string;
  crawlData: CrawlPageData;
  metadata: {
    title: string;
    viewport: { width: number; height: number };
  };
  content?: string;
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([promise, timeout]);
}

export function isCDPConnectionError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error ?? "");
  return [
    "CDP transport closed",
    "socket-close",
    "Session closed",
    "Target closed",
    "Connection closed",
  ].some((snippet) => message.includes(snippet));
}

function buildPageFilename(index: number, url: string, suffix: string) {
  const domain = sanitizeForFilename(url);
  return `page-${index}-${domain}_${suffix}.json`;
}

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function savePageSnapshot(outputDir: string, index: number, snapshot: PageSnapshot) {
  const filename = buildPageFilename(index, snapshot.url, "crawl");
  const filepath = path.join(outputDir, "pages", filename);
  writeJson(filepath, snapshot);
}

export function saveCrawlSummary(outputDir: string, summary: unknown) {
  writeJson(path.join(outputDir, "index.json"), summary);
}

export function getResumeState(outputDir: string): {
  remainingLinks: Array<{ url: string; text: string; linkType: "content" | "entry" }>;
  visitedUrls: Set<string>;
  nextPageIndex: number;
} | null {
  try {
    const pagesDir = path.join(outputDir, "pages");
    if (!fs.existsSync(pagesDir)) {
      return null;
    }

    const page0 = fs
      .readdirSync(pagesDir)
      .filter((filename) => filename.startsWith("page-0-") && filename.endsWith("_crawl.json"));
    if (page0.length === 0) {
      return null;
    }

    const entryData: PageSnapshot = JSON.parse(fs.readFileSync(path.join(pagesDir, page0[0]), "utf-8"));
    const crawlFiles = fs.readdirSync(pagesDir).filter((filename) => filename.endsWith("_crawl.json"));
    const visitedUrls = new Set<string>();

    for (const file of crawlFiles) {
      const data: PageSnapshot = JSON.parse(fs.readFileSync(path.join(pagesDir, file), "utf-8"));
      visitedUrls.add(data.url);
    }

    const remainingLinks = (entryData.crawlData.nextLinks || []).filter((link) => !visitedUrls.has(link.url));

    return {
      remainingLinks,
      visitedUrls,
      nextPageIndex: crawlFiles.length,
    };
  } catch (error) {
    console.error(`Unable to build resume state: ${error}`);
    return null;
  }
}

export function saveAccessibilityTree(outputDir: string, index: number, url: string, tree: unknown) {
  const filename = buildPageFilename(index, url, "a11y");
  writeJson(path.join(outputDir, "pages", filename), tree);
}

async function capturePageArtifacts(
  page: Page,
  outputDir: string,
  index: number,
  url: string
): Promise<string | undefined> {
  try {
    const content = await page.evaluate(() => document.body.innerText);
    const accessibilityTree = await page.mainFrame().getAccessibilityTree(false);
    const html = await page.evaluate(() => document.documentElement.outerHTML);

    saveAccessibilityTree(outputDir, index, url, accessibilityTree);
    await savePageContent(outputDir, index, url, html);
    return content;
  } catch (error) {
    console.warn(`Unable to capture page data for ${url}:`, error);
    return undefined;
  }
}

export async function extractPage(
  stagehand: Stagehand,
  page: Page,
  url: string,
  depth: number,
  config: CrawlConfig,
  outputDir: string,
  pageIndex: number,
  linkType?: "content" | "entry"
): Promise<PageSnapshot> {
  console.log(`\n[Depth ${depth}] ${url}`);
  if (linkType) {
    console.log(`  Link hint: ${linkType}`);
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 60000 });

  let crawlData: CrawlPageData;
  if (depth >= config.maxDepth || linkType === "content") {
    const reason = depth >= config.maxDepth ? "max depth" : "link hint";
    console.log(`  Skipping LLM extraction (${reason}).`);
    crawlData = { pageType: "content-assumed", nextLinks: [] };
  } else {
    crawlData = await stagehand.extract(config.goal, CrawlPageSchema, { page });
    console.log(`  Classified as ${crawlData.pageType} with ${crawlData.nextLinks.length} link(s).`);
  }

  const snapshot: PageSnapshot = {
    url,
    depth,
    timestamp: new Date().toISOString(),
    crawlData,
    metadata: {
      title: await page.title(),
      viewport: { width: 1280, height: 720 },
    },
    content: await capturePageArtifacts(page, outputDir, pageIndex, url),
  };

  return snapshot;
}

export async function crawl(
  stagehand: Stagehand,
  url: string,
  depth: number,
  config: CrawlConfig,
  outputDir: string,
  pageIndex: { current: number },
  visitedUrls: Set<string>,
  parentPage?: Page,
  linkType?: "content" | "entry"
): Promise<void> {
  if (visitedUrls.has(url)) {
    console.log(`Already visited: ${url}`);
    return;
  }

  visitedUrls.add(url);

  const page = parentPage ?? (await stagehand.context.newPage());
  const shouldClosePage = !parentPage;

  try {
    const snapshot = await extractPage(stagehand, page, url, depth, config, outputDir, pageIndex.current, linkType);
    savePageSnapshot(outputDir, pageIndex.current++, snapshot);

    if (depth >= config.maxDepth) {
      return;
    }

    const nextLinks = snapshot.crawlData.nextLinks;
    if (nextLinks.length > 0) {
      console.log(`Exploring ${nextLinks.length} link(s) from ${url}`);
    }

    for (const link of nextLinks) {
      await sleep(config.sleepMs);
      const childPage = await stagehand.context.newPage();

      try {
        await crawl(stagehand, link.url, depth + 1, config, outputDir, pageIndex, visitedUrls, childPage, link.linkType);
      } catch (error) {
        if (isCDPConnectionError(error)) {
          console.error(`Browser connection lost while crawling ${link.url}`);
          throw error;
        }
        console.error(`Error crawling ${link.url}:`, error);
      } finally {
        try {
          await withTimeout(childPage.close(), 5000, "Close child page");
        } catch (closeError) {
          console.warn(`Could not close child page: ${closeError}`);
        }
      }
    }
  } finally {
    if (shouldClosePage) {
      try {
        await withTimeout(page.close(), 5000, "Close parent page");
      } catch (closeError) {
        console.warn(`Could not close parent page: ${closeError}`);
      }
    }
  }
}

async function resumeCrawl(stagehand: Stagehand, resumeDir: string) {
  console.log(`Resuming from ${resumeDir}`);
  const resumeState = getResumeState(resumeDir);

  if (!resumeState) {
    throw new Error("Unable to resume: output directory missing crawl data.");
  }

  if (resumeState.remainingLinks.length === 0) {
    console.log("Crawl is already complete.");
    return;
  }

  const outputDir = resumeDir;
  const pageIndex = { current: resumeState.nextPageIndex };
  const visitedUrls = resumeState.visitedUrls;
  const startUrl = Array.from(visitedUrls)[0];
  console.log(`Visited: ${visitedUrls.size}, Remaining: ${resumeState.remainingLinks.length}`);

  const startTime = Date.now();
  try {
    for (const link of resumeState.remainingLinks) {
      await sleep(defaultConfig.sleepMs);
      const childPage = await stagehand.context.newPage();

      try {
        await crawl(stagehand, link.url, 1, defaultConfig, outputDir, pageIndex, visitedUrls, childPage, link.linkType);
      } catch (error) {
        if (isCDPConnectionError(error)) {
          console.error("Browser connection lost during resume.");
          console.error(`Output saved to: ${outputDir}`);
          console.error(`Resume with: npx tsx scripts/browse-crawl-v3.ts --resume="${outputDir}"`);
        } else {
          console.error(`Error crawling ${link.url}:`, error);
        }
        throw error;
      } finally {
        try {
          await withTimeout(childPage.close(), 5000, "Close child page");
        } catch (closeError) {
          console.warn(`Could not close child page: ${closeError}`);
        }
      }
    }

    saveCrawlSummary(outputDir, {
      startUrl,
      goal: defaultConfig.goal,
      maxDepth: defaultConfig.maxDepth,
      totalPages: pageIndex.current,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      resumed: true,
    });

    console.log(`Resume complete. Total pages: ${pageIndex.current}`);
  } catch (error) {
    console.error("Resume failed:", error);
    throw error;
  }
}

async function freshCrawl(stagehand: Stagehand) {
  console.log("Starting fresh crawl with config:");
  console.log(`  URL: ${defaultConfig.startUrl}`);
  console.log(`  Goal: ${defaultConfig.goal}`);
  console.log(`  Max depth: ${defaultConfig.maxDepth}`);
  console.log(`  Sleep: ${defaultConfig.sleepMs}ms`);

  const outputDir = createOutputDir(sanitizeForFilename(defaultConfig.startUrl));
  console.log(`Output directory: ${outputDir}`);

  const pageIndex = { current: 0 };
  const visitedUrls = new Set<string>();
  const startTime = Date.now();

  try {
    await crawl(stagehand, defaultConfig.startUrl, 0, defaultConfig, outputDir, pageIndex, visitedUrls);

    saveCrawlSummary(outputDir, {
      startUrl: defaultConfig.startUrl,
      goal: defaultConfig.goal,
      maxDepth: defaultConfig.maxDepth,
      totalPages: pageIndex.current,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });

    console.log(`Crawl complete. Pages: ${pageIndex.current}`);
    console.log(`Output: ${outputDir}`);
  } catch (error) {
    if (isCDPConnectionError(error)) {
      console.error("Browser connection lost.");
      console.error(`Output saved to: ${outputDir}`);
      console.error(`Resume with: npx tsx scripts/browse-crawl-v3.ts --resume="${outputDir}"`);
    }
    console.error("Crawl failed:", error);
    throw error;
  }
}

async function main() {
  const resumeArg = process.argv.find((arg) => arg.startsWith("--resume="));
  const resumeDir = resumeArg ? resumeArg.split("=")[1] : undefined;

  console.log("\n🚀 Stagehand Browse Crawler v3\n");

  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 2,
    model: "google/gemini-2.5-flash",
    domSettleTimeout: 5000,
  });

  await stagehand.init();
  console.log("Stagehand ready.\n");

  try {
    if (resumeDir) {
      await resumeCrawl(stagehand, resumeDir);
    } else {
      await freshCrawl(stagehand);
    }
  } finally {
    try {
      await withTimeout(stagehand.close(), 10000, "Close stagehand");
    } catch (closeError) {
      console.error("Unable to close Stagehand cleanly:", closeError);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("\n❌ Fatal error:", error);
    process.exitCode = 1;
  });
}
