// DG-05: the overview video in the Help modal, its captions, and its transcript.
//
// The assets are served from public/, so every check fetches them rather than
// trusting the element attributes — behind a SPA fallback a missing file answers
// 200 with the index.html shell, which a status-only check would pass.

import { test, expect } from "@playwright/test";

test.describe("Help: overview video", () => {
  test("the video, poster and captions all serve as real media", async ({ page, request }) => {
    await page.goto("/#/area");
    await page.getByRole("button", { name: /Help/ }).click();
    await expect(page.locator(".help-video video")).toBeVisible();
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    for (const [path, type] of [
      ["/overview_video.mp4", "video/mp4"],
      ["/overview_video.vtt", "text/vtt"],
      ["/overview_video_poster.jpg", "image/jpeg"],
    ] as const) {
      const res = await request.get(path);
      expect(res.status(), `${path} status`).toBe(200);
      expect(res.headers()["content-type"], `${path} type`).toContain(type);
    }
  });

  test("Cloudflare's 25 MiB per-file asset cap is not exceeded", async ({ request }) => {
    // The 30 MiB original would have been rejected at deploy; it ships re-encoded.
    const body = await (await request.get("/overview_video.mp4")).body();
    expect(body.length).toBeLessThan(25 * 1024 * 1024);
  });

  test("captions parse into cues and are on by default", async ({ page }) => {
    await page.goto("/#/area");
    await page.getByRole("button", { name: /Help/ }).click();
    const video = page.locator(".help-video video");
    const track = await video.evaluate(async (v: HTMLVideoElement) => {
      const t = v.textTracks[0];
      for (let i = 0; i < 60 && !(t.cues && t.cues.length); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return { kind: t.kind, lang: t.language, count: t.cues?.length ?? 0 };
    });
    expect(track.kind).toBe("captions");
    expect(track.lang).toBe("en");
    expect(track.count).toBeGreaterThan(10);
  });

  test("a text transcript is in the DOM as an alternative to watching", async ({ page }) => {
    await page.goto("/#/area");
    await page.getByRole("button", { name: /Help/ }).click();
    const details = page.locator(".help-transcript");
    await expect(details).toBeVisible();
    // Collapsed by default so it does not push the user guide off the modal.
    expect(await details.evaluate((d: HTMLDetailsElement) => d.open)).toBe(false);
    await details.locator("summary").click();
    await expect(details.getByText(/traffic analysis zones/i)).toBeVisible();
    await expect(details.getByText(/download a CSV/i)).toBeVisible();
  });

  test("closing the modal stops playback", async ({ page }) => {
    // Otherwise the audio keeps running, audible and invisible, because closing
    // a <dialog> only hides it.
    await page.goto("/#/area");
    await page.getByRole("button", { name: /Help/ }).click();
    const video = page.locator(".help-video video");
    await video.evaluate((v: HTMLVideoElement) => {
      v.muted = true;
      return v.play();
    });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
    await page.getByRole("button", { name: /Close help/i }).click();
    await expect
      .poll(() => page.evaluate(() =>
        (document.querySelector(".help-video video") as HTMLVideoElement).paused))
      .toBe(true);
  });
});
