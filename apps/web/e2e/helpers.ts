import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

export const ADMIN = { email: 'admin@e2e.local', password: 'admin-e2e-password' }
export const STUB_URL = 'http://127.0.0.1:9399'

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.local`
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth/sign-in')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

export async function signUp(page: Page, name: string, email: string, password: string): Promise<void> {
  await page.goto('/auth/sign-up')
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL('**/auth/sign-in')
}

/** Uploads a file through the documents page and returns its row. */
export async function uploadFile(page: Page, name: string, content: string): Promise<Locator> {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(content),
  })
  const row = page.locator('tbody tr', { hasText: name })
  await expect(row.getByText('Draft')).toBeVisible()
  return row
}

/** Opens a row's "⋯" menu and clicks the named action. */
export async function rowAction(page: Page, row: Locator, label: string): Promise<void> {
  await row.getByRole('button', { name: 'Document actions' }).click()
  await page.getByRole('menuitem', { name: label }).click()
}

/** Drives the RagFlow stub's run state for a document by its file name. */
export async function setStubRun(
  name: string,
  run: string,
  extra: { progress?: number; chunk_count?: number; progress_msg?: string } = {},
): Promise<void> {
  const res = await fetch(`${STUB_URL}/__test/run-by-name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, run, ...extra }),
  })
  expect(res.status).toBe(200)
}

// --- API helpers through the same-origin proxy (as the seeded admin) ---

async function adminApi(request: APIRequestContext): Promise<APIRequestContext> {
  const res = await request.post('/api/auth/sign-in', { data: ADMIN })
  if (res.status() !== 200) throw new Error(`admin sign-in failed with ${res.status()}`)
  return request
}

export async function apiSignUp(request: APIRequestContext, email: string): Promise<void> {
  const res = await request.post('/api/auth/sign-up', {
    data: { name: email.split('@')[0], email, password: 'password123' },
  })
  expect(res.status()).toBe(201)
}

export async function activateUser(request: APIRequestContext, email: string): Promise<void> {
  await adminApi(request)
  const list = await (await request.get('/api/users?page_size=100')).json()
  const user = list.items.find((u: { email: string }) => u.email === email)
  if (user === undefined) throw new Error(`user ${email} not found for activation`)
  const res = await request.patch(`/api/users/${user.id}`, { data: { status: 'active' } })
  expect(res.status()).toBe(200)
}

export async function promoteUser(request: APIRequestContext, email: string): Promise<void> {
  await adminApi(request)
  const list = await (await request.get('/api/users?page_size=100')).json()
  const user = list.items.find((u: { email: string }) => u.email === email)
  if (user === undefined) throw new Error(`user ${email} not found for promotion`)
  const res = await request.patch(`/api/users/${user.id}`, { data: { role: 'super_admin' } })
  expect(res.status()).toBe(200)
}

export async function deactivateUser(request: APIRequestContext, email: string): Promise<void> {
  await adminApi(request)
  const list = await (await request.get('/api/users?page_size=100')).json()
  const user = list.items.find((u: { email: string }) => u.email === email)
  if (user === undefined) throw new Error(`user ${email} not found for deactivation`)
  const res = await request.patch(`/api/users/${user.id}`, { data: { status: 'deactivated' } })
  expect(res.status()).toBe(200)
}
