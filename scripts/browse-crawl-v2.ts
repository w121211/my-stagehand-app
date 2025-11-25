import * as fs from "node:fs";
import * as path from "node:path";
import { Stagehand, type Page } from "@browserbasehq/stagehand";
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { z } from "zod";

// Configuration
const config = {
  // startUrl: "https://news.ycombinator.com",
  // goal: `Find interesting AI and technology news. Extract max 5 links related to AI, machine learning, or tech startups.`,
  startUrl: "https://finance.yahoo.com/",
  goal: `Collect materials for a daily market briefing. Look for Headlines, Trending News, and Market Recaps, but also prioritize stories on Corporate Earnings, Federal Reserve policy, and Global Macroeconomics.`,
  maxDepth: 1,
  sleepMs: 2000,
};

// Zod schema for crawling
const CrawlPageSchema = z.object({
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

type CrawlPageData = z.infer<typeof CrawlPageSchema>;

interface PageSnapshot {
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
async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Utility: Sanitize URL for filename
function sanitizeForFilename(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/\./g, "-");
  } catch {
    return url.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 50);
  }
}

// Utility: Create output directory structure
function createOutputDir(startUrl: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitizedUrl = sanitizeForFilename(startUrl);
  const outputDir = path.join(
    process.cwd(),
    "outputs",
    `${timestamp}-${sanitizedUrl}`
  );
  const pagesDir = path.join(outputDir, "pages");

  fs.mkdirSync(pagesDir, { recursive: true });

  return outputDir;
}

// Utility: Save page snapshot
function savePageSnapshot(
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

// Utility: Save HTML file
function saveHtmlFile(
  outputDir: string,
  index: number,
  url: string,
  html: string
) {
  const domain = sanitizeForFilename(url);
  const filename = `page-${index}-${domain}_html.html`;
  const filepath = path.join(outputDir, "pages", filename);

  fs.writeFileSync(filepath, html);
  console.log(`✓ Saved HTML: ${filename}`);
}

// Utility: Save markdown file
function saveMarkdownFile(
  outputDir: string,
  index: number,
  url: string,
  markdown: string,
  suffix: string
) {
  const domain = sanitizeForFilename(url);
  const filename = `page-${index}-${domain}_${suffix}.md`;
  const filepath = path.join(outputDir, "pages", filename);

  fs.writeFileSync(filepath, markdown);
  console.log(`✓ Saved markdown: ${filename}`);
}

// Utility: Save crawl summary
function saveCrawlSummary(outputDir: string, summary: any) {
  const filepath = path.join(outputDir, "index.json");
  fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
  console.log(`✓ Saved crawl summary: index.json`);
}

// Utility: Save accessibility tree
function saveAccessibilityTree(
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
async function extractPage(
  stagehand: Stagehand,
  page: Page,
  url: string,
  depth: number,
  goal: string,
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
      goal,
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

    // Get HTML content
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    console.log(`   ✓ Captured HTML (${html.length} chars)`);

    // Save HTML file
    saveHtmlFile(outputDir, pageIndex, url, html);

    // Generate markdown using different approaches
    const turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });

    // 1. Raw Turndown (no preprocessing)
    const rawMarkdown = turndownService.turndown(html);
    saveMarkdownFile(outputDir, pageIndex, url, rawMarkdown, "raw");
    console.log(`   ✓ Generated raw markdown (${rawMarkdown.length} chars)`);

    // 2. Readability + Turndown
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article && article.content) {
        const readabilityMarkdown = turndownService.turndown(article.content);
        saveMarkdownFile(outputDir, pageIndex, url, readabilityMarkdown, "readability");
        console.log(`   ✓ Generated Readability markdown (${readabilityMarkdown.length} chars)`);
      }
    } catch (error) {
      console.log(`   ⚠ Readability processing failed: ${error}`);
    }

    // 3. Defuddle
    try {
      const defuddleResult = await Defuddle(html, url, { markdown: true });
      if (defuddleResult.content) {
        saveMarkdownFile(outputDir, pageIndex, url, defuddleResult.content, "defuddle");
        console.log(`   ✓ Generated Defuddle markdown (${defuddleResult.content.length} chars)`);
      }
    } catch (error) {
      console.log(`   ⚠ Defuddle processing failed: ${error}`);
    }
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
async function crawl(
  stagehand: Stagehand,
  url: string,
  depth: number,
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
    const snapshot = await extractPage(stagehand, page, url, depth, config.goal, outputDir, pageIndex.current, linkType);
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
          outputDir,
          pageIndex,
          visitedUrls,
          childPage,
          link.linkType
        );
      } catch (error) {
        console.error(`❌ Error crawling ${link.url}:`, error);
      } finally {
        // Close the child tab after it and all its descendants are done
        console.log(`   🗙 Closing tab: ${link.url}`);
        await childPage.close();
      }
    }

    console.log(`   ✓ Finished exploring children of ${url}`);
  } finally {
    // Only close this page if we created it (not if it was passed from parent)
    if (shouldClosePage) {
      console.log(`   🗙 Closing page: ${url}`);
      await page.close();
    }
  }
}

// Main execution
(async () => {
  console.log("🚀 Starting Stagehand Browse Crawler V2\n");
  console.log(`Start URL: ${config.startUrl}`);
  console.log(`Goal: ${config.goal}`);
  console.log(`Max Depth: ${config.maxDepth}`);
  console.log(`Sleep: ${config.sleepMs}ms between actions\n`);

  // Initialize Stagehand
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 2,
    model: "google/gemini-2.5-flash",
    domSettleTimeout: 5000,
  });

  await stagehand.init();
  console.log("✓ Stagehand initialized\n");

  // Create output directory
  const outputDir = createOutputDir(config.startUrl);
  console.log(`✓ Output directory: ${outputDir}\n`);

  // Track crawl state
  const pageIndex = { current: 0 };
  const visitedUrls = new Set<string>();
  const startTime = Date.now();

  try {
    // Start crawling
    await crawl(
      stagehand,
      config.startUrl,
      0,
      outputDir,
      pageIndex,
      visitedUrls
    );

    // Save summary
    const summary = {
      startUrl: config.startUrl,
      goal: config.goal,
      maxDepth: config.maxDepth,
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
    console.error("\n❌ Crawl failed:", error);
  } finally {
    await stagehand.close();
  }
})();
