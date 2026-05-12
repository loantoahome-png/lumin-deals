'use client'

import { PublicClientApplication, type AccountInfo } from '@azure/msal-browser'

// ── MSAL singleton ──────────────────────────────────────────────────────────
const SCOPES = ['Files.Read.All', 'User.Read', 'offline_access']

let msalPromise: Promise<PublicClientApplication> | null = null

function getClientId(): string {
  const id = process.env.NEXT_PUBLIC_ONEDRIVE_CLIENT_ID
  if (!id) {
    throw new Error('NEXT_PUBLIC_ONEDRIVE_CLIENT_ID not configured. Add it to your env vars.')
  }
  return id
}

async function getMsal(): Promise<PublicClientApplication> {
  if (msalPromise) return msalPromise
  msalPromise = (async () => {
    const instance = new PublicClientApplication({
      auth: {
        clientId: getClientId(),
        authority: 'https://login.microsoftonline.com/common',
        redirectUri: window.location.origin,
      },
      cache: {
        cacheLocation: 'localStorage',
      },
    })
    await instance.initialize()
    return instance
  })()
  return msalPromise
}

export async function isOneDriveSignedIn(): Promise<boolean> {
  try {
    const msal = await getMsal()
    return msal.getAllAccounts().length > 0
  } catch {
    return false
  }
}

export async function signInToOneDrive(): Promise<AccountInfo> {
  const msal = await getMsal()
  const result = await msal.loginPopup({ scopes: SCOPES, prompt: 'select_account' })
  return result.account
}

export async function signOutOfOneDrive(): Promise<void> {
  const msal = await getMsal()
  const accounts = msal.getAllAccounts()
  if (accounts.length === 0) return
  await msal.logoutPopup({ account: accounts[0] })
}

async function getAccessToken(): Promise<string> {
  const msal = await getMsal()
  const account = msal.getAllAccounts()[0]
  if (!account) {
    const result = await msal.loginPopup({ scopes: SCOPES })
    msal.setActiveAccount(result.account)
    return result.accessToken
  }
  try {
    const result = await msal.acquireTokenSilent({ scopes: SCOPES, account })
    return result.accessToken
  } catch {
    const result = await msal.acquireTokenPopup({ scopes: SCOPES, account })
    return result.accessToken
  }
}

// ── Microsoft Graph types ───────────────────────────────────────────────────
export type DriveItem = {
  id: string
  name: string
  webUrl: string
  size?: number
  file?: { mimeType: string }
  folder?: { childCount: number }
  parentReference?: { id: string; path?: string }
  thumbnails?: Array<{ small?: { url: string }; medium?: { url: string } }>
}

const GRAPH = 'https://graph.microsoft.com/v1.0'

async function graphFetch(path: string): Promise<unknown> {
  const token = await getAccessToken()
  const res = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`)
  return res.json()
}

/** List files+folders in a OneDrive folder. Pass 'root' for the top of the drive. */
export async function listDriveChildren(folderId: string = 'root'): Promise<DriveItem[]> {
  const data = await graphFetch(`/me/drive/items/${folderId}/children?$expand=thumbnails&$top=200`) as { value: DriveItem[] }
  return data.value
}

/** Search across the user's entire OneDrive */
export async function searchDrive(query: string): Promise<DriveItem[]> {
  const escaped = encodeURIComponent(`'${query.replace(/'/g, "''")}'`)
  const data = await graphFetch(`/me/drive/root/search(q=${escaped})?$top=50`) as { value: DriveItem[] }
  return data.value
}

/** Get the current user's profile */
export async function getMe(): Promise<{ displayName: string; mail?: string; userPrincipalName?: string }> {
  return graphFetch(`/me?$select=displayName,mail,userPrincipalName`) as Promise<{ displayName: string; mail?: string; userPrincipalName?: string }>
}
