import { Stagehand } from "@browserbasehq/stagehand";
import { crawl, createOutputDir, saveCrawlSummary, getResumeState, sleep, withTimeout, isCDPConnectionError, type CrawlConfig } from "./browse-crawl-v2.js";

const urls = [
    "https://finance.yahoo.com/",
    "https://seekingalpha.com/",
    "https://stratechery.com/",
];

const config: CrawlConfig = {
    goal: "Our purpose is to help a time‑constrained retail investor quickly understand the current market backdrop and near‑term outlook, not just a raw list of headlines. Find and select at most 5 high‑quality pieces that together give a coherent daily market briefing: what has been happening in global markets recently, why it happened, and how today's session is being framed. Prefer integrated market overview and analysis pieces over short, fact‑only headlines. Aim for 2–3 overall market recap/overview pieces, and 1–3 articles on single, high‑impact events that clearly affect major indices, key sectors, or macro themes.",
    maxDepth: 1,
    sleepMs: 2000,
};

async function main() {
    // Parse command line arguments
    const resumeArg = process.argv.find(arg => arg.startsWith("--resume="));
    const resumeDir = resumeArg ? resumeArg.split("=")[1] : null;

    console.log("🚀 Starting Market Briefing Crawler\n");

    const stagehand = new Stagehand({
        env: "LOCAL",
        verbose: 1,
        model: "google/gemini-2.5-flash",
        domSettleTimeout: 5000,
    });

    await stagehand.init();

    try {
        // Resume mode
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

            const outputDir = resumeDir;
            const pageIndex = { current: resumeState.nextPageIndex };
            const visitedUrls = resumeState.visitedUrls;
            const startUrl = Array.from(visitedUrls)[0];

            console.log(`   Visited URLs: ${visitedUrls.size}`);
            console.log(`   Remaining links: ${resumeState.remainingLinks.length}`);
            console.log(`   Next page index: ${pageIndex.current}\n`);

            const startTime = Date.now();

            for (const link of resumeState.remainingLinks) {
                console.log(`\n💤 Sleeping ${config.sleepMs}ms...`);
                await sleep(config.sleepMs);

                const childPage = await stagehand.context.newPage();

                try {
                    await crawl(
                        stagehand,
                        link.url,
                        1,
                        config,
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
                        console.error(`   To resume, run: npx tsx scripts/market-briefing.ts --resume="${outputDir}"\n`);
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

            const summary = {
                startUrl,
                goal: config.goal,
                maxDepth: config.maxDepth,
                totalPages: pageIndex.current,
                duration: Date.now() - startTime,
                timestamp: new Date().toISOString(),
                resumed: true,
            };

            saveCrawlSummary(outputDir, summary);

            console.log(`\n✅ Resumed crawl complete!`);
            console.log(`   Total pages: ${pageIndex.current}`);
            console.log(`   Output: ${outputDir}`);

            return;
        }

        // Normal mode - crawl all URLs
        for (const url of urls) {
            console.log(`\n🌐 Processing: ${url}`);
            const outputDir = createOutputDir(url);
            const pageIndex = { current: 0 };
            const visitedUrls = new Set<string>();
            const startTime = Date.now();

            try {
                await crawl(stagehand, url, 0, config, outputDir, pageIndex, visitedUrls);

                const summary = {
                    startUrl: url,
                    goal: config.goal,
                    maxDepth: config.maxDepth,
                    totalPages: pageIndex.current,
                    duration: Date.now() - startTime,
                    timestamp: new Date().toISOString(),
                };
                saveCrawlSummary(outputDir, summary);
            } catch (error) {
                if (isCDPConnectionError(error)) {
                    console.error(`\n💀 Browser connection lost while processing ${url}!`);
                    console.error(`   Output saved to: ${outputDir}`);
                    console.error(`   To resume this URL, run: npx tsx scripts/market-briefing.ts --resume="${outputDir}"\n`);
                    console.error(`   Then continue with remaining URLs manually.\n`);
                    process.exit(1);
                }
                throw error;
            }
        }
        console.log("\n✅ Market Briefing Crawl Complete!");
    } catch (error) {
        console.error("❌ Error during briefing crawl:", error);
        process.exit(1);
    } finally {
        try {
            await withTimeout(stagehand.close(), 10000, "Close stagehand");
        } catch (closeError) {
            console.error("⚠ Could not close stagehand cleanly:", closeError);
        }
    }
}

main();
