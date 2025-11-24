import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// Configuration
const config = {
  startUrl: "https://news.ycombinator.com",
  goal: `Find interesting AI and technology news. Extract max 5 links related to AI, machine learning, or tech startups.
         For each page, extract: title, abstract (2-3 sentences summarizing the content),
         keywords (array of relevant topics), and publication datetime if available.`,
  maxDepth: 1,
  sleepMs: 2000,
};

// Zod schema for page analysis
const PageAnalysisSchema = z.object({
  pageType: z
    .enum(["content", "entry"])
    .describe(
      "Whether this is a content page (article/post) or entry page (list of links)"
    ),
  links: z
    .array(z.string().url())
    .describe("URLs worth exploring based on the goal"),
  customFields: z.object({
    title: z.string().describe("Page title"),
    abstract: z
      .string()
      .describe("Brief 2-3 sentence summary of the page content"),
    keywords: z.array(z.string()).describe("Array of relevant keywords/topics"),
    datetime: z
      .string()
      .optional()
      .describe("Publication date/time if available"),
  }),
});

type PageAnalysis = z.infer<typeof PageAnalysisSchema>;

interface PageSnapshot {
  url: string;
  depth: number;
  timestamp: string;
  analysis: PageAnalysis;
  metadata: {
    title: string;
    viewport: { width: number; height: number };
  };
  a11yTree?: any;
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
    "crawl-output",
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
  const filename = `page-${index}-${domain}.json`;
  const filepath = path.join(outputDir, "pages", filename);

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
  console.log(`✓ Saved snapshot: ${filename}`);
}

// Utility: Save crawl summary
function saveCrawlSummary(outputDir: string, summary: any) {
  const filepath = path.join(outputDir, "index.json");
  fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
  console.log(`✓ Saved crawl summary: index.json`);
}

// Main: Analyze and snapshot a page
async function analyzePage(
  stagehand: Stagehand,
  page: any,
  url: string,
  depth: number,
  goal: string
): Promise<PageSnapshot> {
  console.log(`\n📄 Analyzing: ${url} (depth: ${depth})`);

  await page.goto(url, { waitUntil: "networkidle" });

  // Single LLM call to get all analysis data
  const analysis = await stagehand.extract<PageAnalysis>(
    goal,
    PageAnalysisSchema,
    { page }
  );

  console.log(`   Page type: ${analysis.pageType}`);
  console.log(`   Title: ${analysis.customFields.title}`);
  console.log(`   Links found: ${analysis.links.length}`);

  // Get page metadata
  const title = await page.title();
  const viewport = page.viewportSize() || { width: 1280, height: 720 };

  // Get accessibility tree (if available)
  let a11yTree;
  try {
    a11yTree = await page.accessibility.snapshot();
  } catch (error) {
    console.log(`   ⚠ Could not capture a11y tree: ${error}`);
  }

  // Get page content (HTML for now, since markdown support unclear)
  let content;
  try {
    content = await page.content();
  } catch (error) {
    console.log(`   ⚠ Could not capture page content: ${error}`);
  }

  const snapshot: PageSnapshot = {
    url,
    depth,
    timestamp: new Date().toISOString(),
    analysis,
    metadata: {
      title,
      viewport,
    },
    a11yTree,
    content,
  };

  return snapshot;
}

// Main: Crawl recursively
async function crawl(
  stagehand: Stagehand,
  url: string,
  depth: number,
  outputDir: string,
  pageIndex: { current: number },
  visitedUrls: Set<string>
): Promise<void> {
  // Check if already visited
  if (visitedUrls.has(url)) {
    console.log(`⏭ Skipping already visited: ${url}`);
    return;
  }

  visitedUrls.add(url);

  // Get or create page
  const pages = stagehand.context.pages();
  const page = pages.length > 0 ? pages[0] : await stagehand.context.newPage();

  // Analyze and snapshot the page
  const snapshot = await analyzePage(stagehand, page, url, depth, config.goal);
  savePageSnapshot(outputDir, pageIndex.current++, snapshot);

  // If at max depth, don't explore further
  if (depth >= config.maxDepth) {
    console.log(`   ⚠ Max depth reached, not exploring links`);
    return;
  }

  // Explore discovered links sequentially
  const linksToExplore = snapshot.analysis.links;
  console.log(`\n🔗 Exploring ${linksToExplore.length} links from ${url}...`);

  for (const link of linksToExplore) {
    // Sleep for polite browsing
    console.log(`\n💤 Sleeping ${config.sleepMs}ms...`);
    await sleep(config.sleepMs);

    // Open new tab
    const newPage = await stagehand.context.newPage();

    try {
      await crawl(
        stagehand,
        link,
        depth + 1,
        outputDir,
        pageIndex,
        visitedUrls
      );
    } catch (error) {
      console.error(`❌ Error crawling ${link}:`, error);
    } finally {
      // Close the tab
      await newPage.close();
    }
  }
}

// Main execution
(async () => {
  console.log("🚀 Starting Stagehand Browse Crawler\n");
  console.log(`Start URL: ${config.startUrl}`);
  console.log(`Goal: ${config.goal}`);
  console.log(`Max Depth: ${config.maxDepth}`);
  console.log(`Sleep: ${config.sleepMs}ms between actions\n`);

  // Initialize Stagehand
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: "openai/gpt-4.1",
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
