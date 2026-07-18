import { expect, test } from "@playwright/test";

test("renders the fixed-camera traffic simulation dashboard", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Ngã tư thông minh" })).toBeVisible();
  await expect(page.getByLabel("Synthetic Detection Overlay")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText(/CCTV fixed camera/)).toBeVisible();
});
