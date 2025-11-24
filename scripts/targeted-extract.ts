// import { Stagehand } from "../../lib/v3";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

async function example(stagehand: Stagehand) {
  const page = stagehand.context.pages()[0];
  await page.goto(
    "https://ambarc.github.io/web-element-test/stagehand-breaking-test.html"
  );

  await page
    .deepLocator("/html/body/div[2]/div[3]/iframe/html/body/p")
    .highlight({
      durationMs: 5000,
      contentColor: { r: 255, g: 0, b: 0 },
    });

  const reason = await stagehand.extract(
    "extract the reason why script injection fails",
    z.string(),
    // selector: "// body > div.test-container > div:nth-child(3) > iframe >> body > p:nth-child(3)",
    { selector: "/html/body/div[2]/div[3]/iframe/html/body/p[2]" }
  );
  console.log(reason);
}

(async () => {
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 2,
    model: "openai/gpt-4.1",
    // logInferenceToFile: true,
    domSettleTimeout: 5000, // Longer wait for stability
    localBrowserLaunchOptions: {
      //   headless: false, // Show browser window
      devtools: true, // Open developer tools
      // viewport: { width: 1280, height: 720 },
      //   // executablePath: "/opt/google/chrome/chrome", // Custom Chrome path
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-web-security",
        "--allow-running-insecure-content",
      ],
      userDataDir: "./chrome-user-data", // Persist browser data
      preserveUserDataDir: true, // Keep data after closing
      chromiumSandbox: false, // Disable sandbox (adds --no-sandbox)
      ignoreHTTPSErrors: true, // Ignore certificate errors
      locale: "en-US", // Set browser language
      // deviceScaleFactor: 1.0, // Display scaling
      //   // proxy: {
      //   //   server: "http://proxy.example.com:8080",
      //   //   username: "user",
      //   //   password: "pass",
      //   // },
      downloadsPath: "./downloads", // Download directory
      acceptDownloads: true, // Allow downloads
      connectTimeoutMs: 30000, // Connection timeout
    },
  });
  await stagehand.init();
  console.log("Chrome launched:", stagehand);

  await example(stagehand);
})();
