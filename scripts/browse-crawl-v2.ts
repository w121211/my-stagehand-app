import * as fs from "node:fs";
import * as path from "node:path";
import { Stagehand, type Page } from "@browserbasehq/stagehand";
import { z } from "zod";
import { createOutputDir, sanitizeForFilename, savePageContent } from "../src/file-utils";

// Configuration
const defaultConfig = {
  // startUrl: "https://news.ycombinator.com",
  // goal: `Find interesting AI and technology news. Extract max 5 links related to AI, machine learning, or tech startups.`,
  startUrl: "https://finance.yahoo.com/",
  goal: `Collect materials for a daily market briefing. Look for Headlines, Trending News, and Market Recaps, but also prioritize stories on Corporate Earnings, Federal Reserve policy, and Global Macroeconomics.`,
  maxDepth: 1,
  sleepMs: 2000,
};

export interface CrawlConfig {
  goal: string;
  maxDepth: number;
  sleepMs: number;
}

// Zod schema for crawling
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
    .describe("Links to explore based on the navigation goal. Return empty array if this is a content page with no relevant links to explore, or if the page is blocked."),
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

// Utility: Sleep function
export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Utility: Wrap promises with timeout
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([promise, timeout]);
}

// Utility: Check if error is a CDP connection error
export function isCDPConnectionError(error: any): boolean {
  const errorStr = String(error?.message || error || "");
  return (
    errorStr.includes("CDP transport closed") ||
    errorStr.includes("socket-close") ||
    errorStr.includes("Session closed") ||
    errorStr.includes("Target closed") ||
    errorStr.includes("Connection closed")
  );
}

// Utility: Save page snapshot
export function savePageSnapshot(
  outputDir: string,
  index: number,
  snapshot: PageSnapshot
) {
  const domain = sanitizeForFilename(snapshot.url);
  const filename = `page-${index}-${domain}_crawl.json`;
  const filepath = path.join(outputDir, "pages", filename);

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
  console.log(`✓ Saved snapshot: ${filename}`);
}

// Utility: Save crawl summary
export function saveCrawlSummary(outputDir: string, summary: any) {
  const filepath = path.join(outputDir, "index.json");
  fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
  console.log(`✓ Saved crawl summary: index.json`);
}

// Utility: Get resume state from existing output directory
export function getResumeState(outputDir: string): {
  remainingLinks: Array<{ url: string; text: string; linkType: "content" | "entry" }>;
  visitedUrls: Set<string>;
  nextPageIndex: number;
} | null {
  try {
    const pagesDir = path.join(outputDir, "pages");

    // Check if directory exists
    if (!fs.existsSync(pagesDir)) {
      return null;
    }

    // Find page-0 crawl file (entry page)
    const page0Files = fs.readdirSync(pagesDir).filter(f => f.startsWith("page-0-") && f.endsWith("_crawl.json"));

    if (page0Files.length === 0) {
      return null;
    }

    // Read page-0 to get all links that should be crawled
    const page0Path = path.join(pagesDir, page0Files[0]);
    const page0Data: PageSnapshot = JSON.parse(fs.readFileSync(page0Path, "utf-8"));
    const allLinks = page0Data.crawlData.nextLinks || [];

    // Read all existing crawl files to see which URLs were already visited
    const crawlFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith("_crawl.json"));
    const visitedUrls = new Set<string>();

    for (const file of crawlFiles) {
      const filePath = path.join(pagesDir, file);
      const data: PageSnapshot = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      visitedUrls.add(data.url);
    }

    // Find remaining links that haven't been crawled
    const remainingLinks = allLinks.filter(link => !visitedUrls.has(link.url));

    return {
      remainingLinks,
      visitedUrls,
      nextPageIndex: crawlFiles.length,
    };
  } catch (error) {
    console.error(`⚠ Error reading resume state: ${error}`);
    return null;
  }
}

// Utility: Save accessibility tree
export function saveAccessibilityTree(
  outputDir: string,
  index: number,
  url: string,
  tree: any
) {
  const domain = sanitizeForFilename(url);
  const filename = `page-${index}-${domain}_a11y.json`;
  const filepath = path.join(outputDir, "pages", filename);

  fs.writeFileSync(filepath, JSON.stringify(tree, null, 2));
  console.log(`✓ Saved accessibility tree: ${filename}`);
}

// Main: Extract and snapshot a page
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
  console.log(`\n📄 Analyzing: ${url} (depth: ${depth})`);
  if (linkType) {
    console.log(`   🔗 Link type hint: ${linkType}`);
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 60000 });

  // Skip LLM extraction if:
  // 1. At max depth, OR
  // 2. Link type is "content" (predicted to be a content page)
  let crawlData: CrawlPageData;
  if (depth >= config.maxDepth) {
    console.log(`   ⚠ Max depth reached - assuming content page (no LLM call)`);
    crawlData = {
      pageType: "content-assumed",
      nextLinks: [],
    };
  } else if (linkType === "content") {
    console.log(`   ⚡ Content page detected - skipping LLM extraction`);
    crawlData = {
      pageType: "content-assumed",
      nextLinks: [],
    };
  } else {
    // Single LLM call to get crawl data
    crawlData = await stagehand.extract(
      config.goal,
      CrawlPageSchema,
      { page }
    );

    console.log(`   Page type: ${crawlData.pageType}`);
    console.log(`   Next links found: ${crawlData.nextLinks.length}`);
    if (crawlData.nextLinks.length > 0) {
      crawlData.nextLinks.slice(0, 3).forEach((link) => {
        console.log(`     - ${link.text} [${link.linkType}]`);
      });
      if (crawlData.nextLinks.length > 3) {
        console.log(`     ... and ${crawlData.nextLinks.length - 3} more`);
      }
    }
  }

  // Get page metadata
  const title = await page.title();
  const viewport = { width: 1280, height: 720 };

  // Get page content, HTML, and accessibility tree for ALL pages
  let content;
  try {
    // Capture text content
    content = await page.evaluate(() => document.body.innerText);
    console.log(`   ✓ Captured content (${content.length} chars)`);

    // Capture accessibility tree
    const accessibilityTree = await page.mainFrame().getAccessibilityTree(false);
    console.log(`   ✓ Captured accessibility tree (${accessibilityTree.length} nodes)`);
    saveAccessibilityTree(outputDir, pageIndex, url, accessibilityTree);

    // Get HTML content and save (HTML + markdown variants)
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    console.log(`   ✓ Captured HTML (${html.length} chars)`);
    await savePageContent(outputDir, pageIndex, url, html);
  } catch (error) {
    console.log(`   ⚠ Could not capture page data: ${error}`);
  }

  const snapshot: PageSnapshot = {
    url,
    depth,
    timestamp: new Date().toISOString(),
    crawlData,
    metadata: {
      title,
      viewport,
    },
    content,
  };

  return snapshot;
}

// Main: Crawl recursively (DFS with proper page lifecycle)
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
  // Check if already visited
  if (visitedUrls.has(url)) {
    console.log(`⏭ Skipping already visited: ${url}`);
    return;
  }

  visitedUrls.add(url);

  // Create a new page for this URL (or use parent page if this is the root)
  const page = parentPage || await stagehand.context.newPage();
  const shouldClosePage = !parentPage; // Only close if we created it

  try {
    // Extract and snapshot the page
    const snapshot = await extractPage(stagehand, page, url, depth, config, outputDir, pageIndex.current, linkType);
    savePageSnapshot(outputDir, pageIndex.current++, snapshot);

    // If at max depth, don't explore further
    if (depth >= config.maxDepth) {
      console.log(`   ⚠ Max depth reached, not exploring links`);
      return;
    }

    // Explore discovered links sequentially (DFS)
    const nextLinks = snapshot.crawlData.nextLinks;
    console.log(`\n🔗 Exploring ${nextLinks.length} links from ${url}...`);
    console.log(`   📑 Parent page staying open during child exploration`);

    for (const link of nextLinks) {
      // Sleep for polite browsing
      console.log(`\n💤 Sleeping ${config.sleepMs}ms...`);
      await sleep(config.sleepMs);

      // Open new tab for child
      const childPage = await stagehand.context.newPage();

      try {
        // Recursively crawl (DFS), passing the child page and link type
        await crawl(
          stagehand,
          link.url,
          depth + 1,
          config,
          outputDir,
          pageIndex,
          visitedUrls,
          childPage,
          link.linkType
        );
      } catch (error) {
        // Check if this is a CDP connection error
        if (isCDPConnectionError(error)) {
          console.error(`\n💀 CDP connection lost while crawling ${link.url}`);
          console.error(`   Browser connection is dead. Exiting gracefully...`);
          throw error; // Re-throw to propagate up and exit
        }
        console.error(`❌ Error crawling ${link.url}:`, error);
      } finally {
        // Close the child tab after it and all its descendants are done
        console.log(`   🗙 Closing tab: ${link.url}`);
        try {
          await withTimeout(childPage.close(), 5000, "Close child page");
        } catch (closeError) {
          console.warn(`   ⚠ Could not close child page: ${closeError}`);
        }
      }
    }

    console.log(`   ✓ Finished exploring children of ${url}`);
  } finally {
    // Only close this page if we created it (not if it was passed from parent)
    if (shouldClosePage) {
      console.log(`   🗙 Closing page: ${url}`);
      try {
        await withTimeout(page.close(), 5000, "Close parent page");
      } catch (closeError) {
        console.warn(`   ⚠ Could not close parent page: ${closeError}`);
      }
    }
  }
}

// Main execution
import { fileURLToPath } from "url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    // Parse command line arguments
    const resumeArg = process.argv.find(arg => arg.startsWith("--resume="));
    const resumeDir = resumeArg ? resumeArg.split("=")[1] : null;

    console.log("🚀 Starting Stagehand Browse Crawler V2\n");

    // Initialize Stagehand
    const stagehand = new Stagehand({
      env: "LOCAL",
      verbose: 2,
      model: "google/gemini-2.5-flash",
      domSettleTimeout: 5000,
    });

    await stagehand.init();
    console.log("✓ Stagehand initialized\n");

    let outputDir: string;
    let pageIndex: { current: number };
    let visitedUrls: Set<string>;
    let startUrl: string;

    // Check if resuming from existing crawl
    if (resumeDir) {
      console.log(`🔄 Resuming from: ${resumeDir}\n`);
      const resumeState = getResumeState(resumeDir);

      if (!resumeState) {
        console.error("❌ Could not resume - invalid or empty output directory");
        process.exit(1);
      }

      if (resumeState.remainingLinks.length === 0) {
        console.log("✅ No remaining links to crawl - already complete!");
        process.exit(0);
      }

      outputDir = resumeDir;
      pageIndex = { current: resumeState.nextPageIndex };
      visitedUrls = resumeState.visitedUrls;
      startUrl = Array.from(visitedUrls)[0]; // First URL is the start URL

      console.log(`   Visited URLs: ${visitedUrls.size}`);
      console.log(`   Remaining links: ${resumeState.remainingLinks.length}`);
      console.log(`   Next page index: ${pageIndex.current}\n`);

      // Resume crawling remaining links
      const startTime = Date.now();
      try {
        for (const link of resumeState.remainingLinks) {
          console.log(`\n💤 Sleeping ${defaultConfig.sleepMs}ms...`);
          await sleep(defaultConfig.sleepMs);

          const childPage = await stagehand.context.newPage();

          try {
            await crawl(
              stagehand,
              link.url,
              1, // Depth is 1 for resumed links (children of root)
              defaultConfig,
              outputDir,
              pageIndex,
              visitedUrls,
              childPage,
              link.linkType
            );
          } catch (error) {
            if (isCDPConnectionError(error)) {
              console.error(`\n💀 Browser connection lost!`);
              console.error(`   Output saved to: ${outputDir}`);
              console.error(`   To resume, run: npx tsx scripts/browse-crawl-v2.ts --resume="${outputDir}"\n`);
              process.exit(1);
            }
            console.error(`❌ Error crawling ${link.url}:`, error);
          } finally {
            try {
              await withTimeout(childPage.close(), 5000, "Close child page");
            } catch (closeError) {
              console.warn(`   ⚠ Could not close child page: ${closeError}`);
            }
          }
        }

        // Save updated summary
        const summary = {
          startUrl,
          goal: defaultConfig.goal,
          maxDepth: defaultConfig.maxDepth,
          totalPages: pageIndex.current,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          resumed: true,
        };

        saveCrawlSummary(outputDir, summary);

        console.log(`\n✅ Resumed crawl complete!`);
        console.log(`   Total pages: ${pageIndex.current}`);
        console.log(`   Output: ${outputDir}`);
      } catch (error) {
        console.error("\n❌ Resume failed:", error);
      } finally {
        try {
          await withTimeout(stagehand.close(), 10000, "Close stagehand");
        } catch (closeError) {
          console.error("⚠ Could not close stagehand cleanly:", closeError);
        }
      }
      process.exit(0);
    }

    // Normal crawl (not resuming)
    console.log(`Start URL: ${defaultConfig.startUrl}`);
    console.log(`Goal: ${defaultConfig.goal}`);
    console.log(`Max Depth: ${defaultConfig.maxDepth}`);
    console.log(`Sleep: ${defaultConfig.sleepMs}ms between actions\n`);

    // Create output directory
    outputDir = createOutputDir(sanitizeForFilename(defaultConfig.startUrl));
    console.log(`✓ Output directory: ${outputDir}\n`);

    // Track crawl state
    pageIndex = { current: 0 };
    visitedUrls = new Set<string>();
    const startTime = Date.now();

    try {
      // Start crawling
      await crawl(
        stagehand,
        defaultConfig.startUrl,
        0,
        defaultConfig,
        outputDir,
        pageIndex,
        visitedUrls
      );

      // Save summary
      const summary = {
        startUrl: defaultConfig.startUrl,
        goal: defaultConfig.goal,
        maxDepth: defaultConfig.maxDepth,
        totalPages: pageIndex.current,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      saveCrawlSummary(outputDir, summary);

      console.log(`\n✅ Crawl complete!`);
      console.log(`   Pages crawled: ${pageIndex.current}`);
      console.log(`   Duration: ${summary.duration}ms`);
      console.log(`   Output: ${outputDir}`);
    } catch (error) {
      if (isCDPConnectionError(error)) {
        console.error("\n💀 Browser connection lost!");
        console.error(`   Output saved to: ${outputDir}`);
        console.error(`   To resume, run: npx tsx scripts/browse-crawl-v2.ts --resume="${outputDir}"\n`);
        process.exit(1);
      }
      console.error("\n❌ Crawl failed:", error);
    } finally {
      try {
        await withTimeout(stagehand.close(), 10000, "Close stagehand");
      } catch (closeError) {
        console.error("⚠ Could not close stagehand cleanly:", closeError);
      }
    }
  })();
}
