import type { VaultConfig } from "./db";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

async function rest<T>(cfg: Pick<VaultConfig, "token">, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new GitHubError(body.message ?? `GitHub ${res.status}`, res.status);
  }
  return res.json();
}

async function graphql<T>(
  cfg: Pick<VaultConfig, "token">,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GitHubError(body.message ?? `GitHub ${res.status}`, res.status);
  if (body.errors?.length) throw new GitHubError(body.errors.map((e: { message: string }) => e.message).join("; "));
  return body.data;
}

export async function getRepoInfo(cfg: Pick<VaultConfig, "token" | "owner" | "repo">) {
  return rest<{ default_branch: string; private: boolean; full_name: string }>(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}`,
  );
}

export async function getHeadCommit(cfg: VaultConfig): Promise<{ oid: string; treeSha: string }> {
  const commit = await rest<{ sha: string; commit: { tree: { sha: string } } }>(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}`,
  );
  return { oid: commit.sha, treeSha: commit.commit.tree.sha };
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export async function getTree(cfg: VaultConfig, treeSha: string): Promise<TreeEntry[]> {
  const tree = await rest<{
    truncated: boolean;
    tree: { path: string; type: string; sha: string; size?: number }[];
  }>(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated) {
    throw new GitHubError("Repository tree is too large to list in one request (>100k entries).");
  }
  return tree.tree
    .filter((e) => e.type === "blob")
    .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
}

const decoder = new TextDecoder();

function base64ToBytes(b64: string) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function getBlobText(cfg: VaultConfig, sha: string) {
  const blob = await rest<{ content: string }>(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/blobs/${sha}`);
  return decoder.decode(base64ToBytes(blob.content));
}

const BATCH = 50;

/**
 * Fetches the text of many blobs, 50 per GraphQL request. Blobs GraphQL
 * truncates (very large files) fall back to the REST blob endpoint.
 */
export async function getBlobTexts(
  cfg: VaultConfig,
  shas: string[],
  onProgress?: (done: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(shas)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const fields = chunk
      .map((sha, j) => `b${j}: object(oid: ${JSON.stringify(sha)}) { ... on Blob { text isTruncated } }`)
      .join("\n");
    const data = await graphql<{ repository: Record<string, { text: string | null; isTruncated: boolean } | null> }>(
      cfg,
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`,
      { owner: cfg.owner, repo: cfg.repo },
    );
    for (let j = 0; j < chunk.length; j++) {
      const blob = data.repository[`b${j}`];
      if (blob && blob.text !== null && !blob.isTruncated) out.set(chunk[j], blob.text);
      else out.set(chunk[j], await getBlobText(cfg, chunk[j]));
    }
    onProgress?.(Math.min(i + BATCH, unique.length));
  }
  return out;
}

export class StaleHeadError extends GitHubError {}

/**
 * Creates a single commit with all changes. Fails with StaleHeadError if the
 * branch moved since `expectedHeadOid`, so remote work is never overwritten.
 */
export async function createCommit(
  cfg: VaultConfig,
  expectedHeadOid: string,
  message: string,
  additions: { path: string; content: string }[],
  deletions: string[],
): Promise<string> {
  const encoder = new TextEncoder();
  try {
    const data = await graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
      cfg,
      `mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
      }`,
      {
        input: {
          branch: { repositoryNameWithOwner: `${cfg.owner}/${cfg.repo}`, branchName: cfg.branch },
          message: { headline: message },
          expectedHeadOid,
          fileChanges: {
            additions: additions.map((a) => ({ path: a.path, contents: bytesToBase64(encoder.encode(a.content)) })),
            deletions: deletions.map((path) => ({ path })),
          },
        },
      },
    );
    return data.createCommitOnBranch.commit.oid;
  } catch (e) {
    // GitHub: 'Expected branch to point to "<oid>" but it did not. Pull and try again!'
    if (e instanceof GitHubError && /expected branch to point to/i.test(e.message)) {
      throw new StaleHeadError(e.message, e.status);
    }
    throw e;
  }
}

/** Git's blob sha: sha1("blob <len>\0<bytes>"). Lets us track pushed files without a re-fetch. */
export async function gitBlobSha(content: string) {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
