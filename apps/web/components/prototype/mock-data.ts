// PROTOTYPE — mock data for the UI prototype. No persistence, no API.
// Mirrors the domain model locked in CONTEXT.md and the wayfinder map.

export type DocStatus = "draft" | "ready" | "publishing" | "published" | "failed"
export type Role = "member" | "super_admin"
export type UserStatus = "active" | "pending" | "deactivated"

export interface Doc {
  id: string
  name: string
  ext: string
  size: string
  status: DocStatus
  ownerId: string
  ownerName: string
  updatedAt: string
  progress?: number
  retriesLeft?: number
  chunks?: number
  history: string[]
}

export interface AppUser {
  id: string
  name: string
  email: string
  role: Role
  status: UserStatus
  joinedAt: string
}

export const DATASET = "monitorerp-china-internal"

export const currentUser: AppUser = {
  id: "u1",
  name: "Li Wei",
  email: "li.wei@monitorerp.cn",
  role: "member",
  status: "active",
  joinedAt: "2026-03-02",
}

export const docs: Doc[] = [
  {
    id: "d1",
    name: "Q3 Sales Report — China Region",
    ext: "pdf",
    size: "12.4 MB",
    status: "published",
    ownerId: "u1",
    ownerName: "Li Wei",
    updatedAt: "Jul 28",
    chunks: 42,
    history: ["Uploaded Jun 30", "Published Jul 1", "Re-published Jul 28"],
  },
  {
    id: "d2",
    name: "ERP Onboarding Guide",
    ext: "md",
    size: "86 KB",
    status: "published",
    ownerId: "u2",
    ownerName: "Chen Lin",
    updatedAt: "Jul 25",
    chunks: 15,
    history: ["Uploaded Jul 10", "Published Jul 12", "Withdrawn Jul 20", "Published Jul 25"],
  },
  {
    id: "d3",
    name: "Pricing 2026 Draft",
    ext: "docx",
    size: "1.2 MB",
    status: "draft",
    ownerId: "u1",
    ownerName: "Li Wei",
    updatedAt: "Aug 2",
    history: ["Uploaded Aug 2"],
  },
  {
    id: "d4",
    name: "Data Migration Plan",
    ext: "xlsx",
    size: "340 KB",
    status: "ready",
    ownerId: "u2",
    ownerName: "Chen Lin",
    updatedAt: "Aug 4",
    history: ["Uploaded Aug 1", "Marked ready Aug 4"],
  },
  {
    id: "d5",
    name: "Board Minutes — July",
    ext: "pptx",
    size: "8.1 MB",
    status: "publishing",
    ownerId: "u1",
    ownerName: "Li Wei",
    updatedAt: "Aug 6",
    progress: 64,
    history: ["Uploaded Aug 5", "Publish started Aug 6"],
  },
  {
    id: "d6",
    name: "Supplier Contract v2",
    ext: "pdf",
    size: "2.6 MB",
    status: "failed",
    ownerId: "u1",
    ownerName: "Li Wei",
    updatedAt: "Aug 7",
    retriesLeft: 2,
    history: [
      "Uploaded Jul 18",
      "Published Jul 19",
      "Withdrawn Aug 1",
      "Marked ready Aug 5",
      "Publish failed Aug 7",
    ],
  },
  {
    id: "d7",
    name: "API Integration Spec",
    ext: "md",
    size: "120 KB",
    status: "ready",
    ownerId: "u1",
    ownerName: "Li Wei",
    updatedAt: "Aug 3",
    history: ["Uploaded Aug 3", "Marked ready Aug 3"],
  },
  {
    id: "d8",
    name: "Inventory Policy",
    ext: "docx",
    size: "900 KB",
    status: "draft",
    ownerId: "u2",
    ownerName: "Chen Lin",
    updatedAt: "Jul 30",
    history: ["Uploaded Jul 30"],
  },
]

export const users: AppUser[] = [
  currentUser,
  {
    id: "u2",
    name: "Chen Lin",
    email: "chen.lin@monitorerp.cn",
    role: "member",
    status: "active",
    joinedAt: "2026-04-11",
  },
  {
    id: "u3",
    name: "Liu Fang",
    email: "liu.fang@monitorerp.cn",
    role: "member",
    status: "pending",
    joinedAt: "2026-08-06",
  },
  {
    id: "u4",
    name: "Zhang Wei",
    email: "zhang.wei@monitorerp.cn",
    role: "super_admin",
    status: "active",
    joinedAt: "2026-02-20",
  },
  {
    id: "u5",
    name: "Sun Qi",
    email: "sun.qi@monitorerp.cn",
    role: "member",
    status: "deactivated",
    joinedAt: "2026-05-03",
  },
]

export const STATUS_ORDER: DocStatus[] = ["draft", "ready", "publishing", "published", "failed"]

export const STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
}
