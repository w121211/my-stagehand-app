import * as fs from "node:fs";
import * as path from "node:path";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { createOutputDir, savePageContent } from "../src/file-utils";

// Simple link extraction - just get the main entry links
const LinkSchema = z.object({
  links: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string(),
      })
    )
    .max(10)
    .describe(
      "Extract up to 10 main entry links from headline, top stories, or trending sections"
    ),
});

async function main() {
  console.log("🚀 Starting simple link extraction\n");

  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: "google/gemini-2.5-flash",
  });

  await stagehand.init();
  const page = stagehand.context.pages()[0];

  // Navigate to the page
  const url = "https://finance.yahoo.com/";
  console.log(`📄 Loading: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Create output directory
  const outputDir = createOutputDir("simple-link-extract");
  console.log(`✓ Output directory: ${outputDir}\n`);

  // Save page content (HTML + markdown variants)
  console.log("💾 Saving page content...\n");
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  await savePageContent(outputDir, 0, url, html);

  // Extract links
  console.log("\n🔍 Extracting main links...\n");
  const result = await stagehand.extract(
    "Extract the main headline, top stories, and trending article links (max 10 total)",
    LinkSchema
  );

  // Save links JSON
  const linksFilepath = path.join(outputDir, "links.json");
  fs.writeFileSync(
    linksFilepath,
    JSON.stringify(
      {
        url,
        timestamp: new Date().toISOString(),
        links: result.links,
      },
      null,
      2
    )
  );
  console.log(`✓ Saved links: links.json\n`);

  // Display results
  console.log("✅ Found links:\n");
  result.links.forEach((link, i) => {
    console.log(`${i + 1}. ${link.title}`);
    console.log(`   ${link.url}\n`);
  });

  console.log(`\n📊 Total: ${result.links.length} links`);
  console.log(`📁 Output: ${outputDir}`);

  await stagehand.close();
}

main().catch(console.error);
