import { test, expect } from '@playwright/test'

// Real-browser end-to-end sign flow: login -> upload -> place fields ->
// finalize -> download the signed PDF. Deliberately uses only Date + Text
// fields (not Signature) — the signature field needs a canvas draw gesture
// that's brittle headless, while Date + Text alone exercise the full
// flatten + certificate + finalize + download pipeline.
//
// Selectors match the real components as built:
//  - Login: src/app/(auth)/login/page.tsx — input[name=email],
//    input[name=password], a single button[type=submit].
//  - Upload: src/components/documents/UploadDropzone.tsx — a hidden
//    <input type="file"> inside the dropzone card.
//  - Field toolbar: src/components/pdf-editor/FieldToolbar.tsx — buttons
//    literally labeled "Signature" / "Date" / "Text" (addField() drops the
//    field at a default position on the active page — no drag needed to
//    make it finalizable).
//  - Finalize: src/components/pdf-editor/Editor.tsx — button labeled
//    "Finalize"; on success it renders a `role="status"` element reading
//    "Finalized.".
//  - Download: the signed-download link only exists on the documents list
//    (src/components/documents/DocumentList.tsx), not on the editor page
//    itself, and only once doc.status === 'signed' — so the flow navigates
//    back to /documents after finalize and clicks it there.
test('login -> upload -> sign -> finalize -> download', async ({ page }) => {
  await page.goto('/login')
  await page.fill('input[name=email]', process.env.SEED_ADMIN_EMAIL!)
  await page.fill('input[name=password]', process.env.SEED_ADMIN_PASSWORD!)
  await page.click('button[type=submit]')

  await page.waitForURL(/\/documents$/)

  await page.setInputFiles('input[type=file]', 'e2e/fixtures/sample.pdf')
  await page.waitForURL(/\/documents\/.+\/edit/)

  const editUrl = new URL(page.url())
  const docId = editUrl.pathname.match(/\/documents\/([^/]+)\/edit/)?.[1]
  expect(docId).toBeTruthy()

  // Wait for the PDF to actually load before placing fields (Editor.tsx
  // shows "Loading document..." until its fetch of /file/original resolves,
  // and the toolbar buttons are disabled until then).
  await expect(page.getByRole('button', { name: 'Date', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: 'Date', exact: true }).click()
  await page.getByRole('button', { name: 'Text', exact: true }).click()

  await page.getByRole('button', { name: 'Finalize', exact: true }).click()
  await expect(page.getByText('Finalized.')).toBeVisible()

  // The signed-download link lives on the documents list, gated on
  // doc.status === 'signed' (server-rendered) — go there to fetch it.
  await page.goto('/documents')
  const downloadLink = page.locator(`a[href="/api/documents/${docId}/file/signed"]`)
  await expect(downloadLink).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadLink.click(),
  ])

  // Content-Disposition (Task 13) drives both of these: Chromium treats the
  // navigation as a download (not an inline PDF render) precisely because of
  // `attachment`, and the suggested filename comes from the sanitized
  // "<base>-signed.pdf" name the route derives from originalName.
  expect(download.suggestedFilename()).toBe('sample-signed.pdf')
  expect(await download.path()).toBeTruthy()
})
