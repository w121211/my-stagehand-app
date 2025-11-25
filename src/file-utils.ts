import * as fs from "node:fs";
import * as path from "node:path";
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

// Utility: Sanitize URL for filename
export function sanitizeForFilename(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/\./g, "-");
  } catch {
    return url.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 50);
  }
}

// Utility: Create output directory structure
export function createOutputDir(identifier: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(
    process.cwd(),
    "outputs",
    `${timestamp}-${identifier}`
  );
  const pagesDir = path.join(outputDir, "pages");

  fs.mkdirSync(pagesDir, { recursive: true });

  return outputDir;
}

// Utility: Save page content (HTML + multiple markdown formats)
export async function savePageContent(
  outputDir: string,
  index: number,
  url: string,
  html: string
): Promise<void> {
  const domain = sanitizeForFilename(url);
  const pagesDir = path.join(outputDir, "pages");

  // Save HTML file
  const htmlFilename = `page-${index}-${domain}_html.html`;
  const htmlFilepath = path.join(pagesDir, htmlFilename);
  fs.writeFileSync(htmlFilepath, html);
  console.log(`✓ Saved HTML: ${htmlFilename}`);

  // Generate markdown using different approaches
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  // 1. Raw Turndown (no preprocessing)
  const rawMarkdown = turndownService.turndown(html);
  const rawFilename = `page-${index}-${domain}_raw.md`;
  fs.writeFileSync(path.join(pagesDir, rawFilename), rawMarkdown);
  console.log(`✓ Saved raw markdown: ${rawFilename} (${rawMarkdown.length} chars)`);

  // 2. Readability + Turndown
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article && article.content) {
      const readabilityMarkdown = turndownService.turndown(article.content);
      const readabilityFilename = `page-${index}-${domain}_readability.md`;
      fs.writeFileSync(path.join(pagesDir, readabilityFilename), readabilityMarkdown);
      console.log(`✓ Saved Readability markdown: ${readabilityFilename} (${readabilityMarkdown.length} chars)`);
    }
  } catch (error) {
    console.log(`⚠ Readability processing failed: ${error}`);
  }

  // 3. Defuddle
  try {
    const defuddleResult = await Defuddle(html, url, { markdown: true });
    if (defuddleResult.content) {
      const defuddleFilename = `page-${index}-${domain}_defuddle.md`;
      fs.writeFileSync(path.join(pagesDir, defuddleFilename), defuddleResult.content);
      console.log(`✓ Saved Defuddle markdown: ${defuddleFilename} (${defuddleResult.content.length} chars)`);
    }
  } catch (error) {
    console.log(`⚠ Defuddle processing failed: ${error}`);
  }
}
