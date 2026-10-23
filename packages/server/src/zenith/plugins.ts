import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./database.js";
import { ZenithError } from "./types.js";

/**
 * 插件商店服务端：目录 JSON 与官方 marketplace.json 兼容，插件包由本服务托管。
 * 后台既可以录入外链，也可以上传 zip（base64）落到数据目录。
 */

export interface PluginRow {
  id: string;
  plugin_name: string;
  version: string;
  display_name: string;
  description: string;
  category: string;
  publisher_type: string;
  author: string;
  icon_url: string;
  homepage: string;
  download_url: string;
  storage_path: string;
  sha256: string;
  size: number;
  featured: number;
  enabled: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

export const OFFICIAL_MARKETPLACE_CDN_URL =
  "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";

export function pluginStorageDir(dataDir: string): string {
  const dir = join(dataDir, "plugins");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function toPluginView(row: PluginRow) {
  return {
    id: row.id,
    pluginName: row.plugin_name,
    version: row.version,
    displayName: row.display_name || row.plugin_name,
    description: row.description,
    category: row.category,
    publisherType: row.publisher_type,
    author: row.author,
    iconUrl: row.icon_url,
    homepage: row.homepage,
    downloadUrl: row.download_url,
    hasPackage: Boolean(row.storage_path),
    sha256: row.sha256,
    size: row.size,
    featured: Boolean(row.featured),
    enabled: Boolean(row.enabled),
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPlugins(db: DatabaseSync, enabledOnly = false) {
  const sql = enabledOnly
    ? "SELECT * FROM plugins WHERE enabled = 1 ORDER BY sort ASC, plugin_name ASC"
    : "SELECT * FROM plugins ORDER BY sort ASC, plugin_name ASC";
  const rows = db.prepare(sql).all() as unknown as PluginRow[];
  return rows.map(toPluginView);
}

export interface PluginInput {
  pluginName?: unknown;
  version?: unknown;
  displayName?: unknown;
  description?: unknown;
  category?: unknown;
  publisherType?: unknown;
  author?: unknown;
  iconUrl?: unknown;
  homepage?: unknown;
  downloadUrl?: unknown;
  featured?: unknown;
  enabled?: unknown;
  sort?: unknown;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function upsertPlugin(db: DatabaseSync, input: PluginInput): PluginRow {
  const pluginName = readString(input.pluginName);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginName)) {
    throw new ZenithError(400, "pluginName 只能包含字母、数字、点、下划线和短横线");
  }
  const version = readString(input.version, "latest") || "latest";
  const now = Date.now();
  const existing = db
    .prepare("SELECT * FROM plugins WHERE plugin_name = ? AND version = ?")
    .get(pluginName, version) as unknown as PluginRow | undefined;

  if (existing) {
    db.prepare(
      "UPDATE plugins SET display_name = ?, description = ?, category = ?, publisher_type = ?, " +
        "author = ?, icon_url = ?, homepage = ?, download_url = ?, featured = ?, enabled = ?, sort = ?, updated_at = ? " +
        "WHERE id = ?",
    ).run(
      readString(input.displayName, existing.display_name),
      readString(input.description, existing.description),
      readString(input.category, existing.category),
      readString(input.publisherType, existing.publisher_type) === "community" ? "community" : "official",
      readString(input.author, existing.author),
      readString(input.iconUrl, existing.icon_url),
      readString(input.homepage, existing.homepage),
      readString(input.downloadUrl, existing.download_url),
      input.featured === undefined ? existing.featured : input.featured ? 1 : 0,
      input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      input.sort === undefined ? existing.sort : Number(input.sort) || 0,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      "INSERT INTO plugins (id, plugin_name, version, display_name, description, category, publisher_type, " +
        "author, icon_url, homepage, download_url, featured, enabled, sort, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      newId("plugin"),
      pluginName,
      version,
      readString(input.displayName, pluginName),
      readString(input.description),
      readString(input.category),
      readString(input.publisherType) === "community" ? "community" : "official",
      readString(input.author),
      readString(input.iconUrl),
      readString(input.homepage),
      readString(input.downloadUrl),
      input.featured ? 1 : 0,
      input.enabled === false ? 0 : 1,
      Number(input.sort) || 0,
      now,
      now,
    );
  }

  return db
    .prepare("SELECT * FROM plugins WHERE plugin_name = ? AND version = ?")
    .get(pluginName, version) as unknown as PluginRow;
}

export function deletePlugin(db: DatabaseSync, id: string): void {
  const result = db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
  if (Number(result.changes) === 0) throw new ZenithError(404, "插件不存在");
}

export function updatePluginById(db: DatabaseSync, id: string, patch: PluginInput): PluginRow {
  const row = db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as unknown as
    | PluginRow
    | undefined;
  if (!row) throw new ZenithError(404, "插件不存在");
  return upsertPlugin(db, {
    pluginName: row.plugin_name,
    version: row.version,
    displayName: patch.displayName ?? row.display_name,
    description: patch.description ?? row.description,
    category: patch.category ?? row.category,
    publisherType: patch.publisherType ?? row.publisher_type,
    author: patch.author ?? row.author,
    iconUrl: patch.iconUrl ?? row.icon_url,
    homepage: patch.homepage ?? row.homepage,
    downloadUrl: patch.downloadUrl ?? row.download_url,
    featured: patch.featured ?? Boolean(row.featured),
    enabled: patch.enabled ?? Boolean(row.enabled),
    sort: patch.sort ?? row.sort,
  });
}

export interface UploadPluginInput {
  pluginName: string;
  version?: string;
  dataBase64: string;
  sha256?: string;
}

export function savePluginPackage(db: DatabaseSync, dataDir: string, input: UploadPluginInput): PluginRow {
  const pluginName = input.pluginName.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginName)) {
    throw new ZenithError(400, "pluginName 不合法");
  }
  const version = (input.version?.trim() || "latest").replace(/[^a-zA-Z0-9._-]/g, "_");
  const buffer = Buffer.from(input.dataBase64, "base64");
  if (buffer.length === 0) throw new ZenithError(400, "插件包为空");
  if (buffer.length > 50 * 1024 * 1024) throw new ZenithError(413, "插件包不能超过 50MB");

  const hash = createHash("sha256").update(buffer).digest("hex");
  if (input.sha256 && input.sha256.trim().toLowerCase() !== hash) {
    throw new ZenithError(400, "sha256 与插件包内容不一致");
  }

  const dir = join(pluginStorageDir(dataDir), pluginName);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${version}.zip`);
  writeFileSync(filePath, buffer);

  const row = upsertPlugin(db, {
    pluginName,
    version,
    downloadUrl: "",
  });
  db.prepare(
    "UPDATE plugins SET storage_path = ?, sha256 = ?, size = ?, updated_at = ? WHERE id = ?",
  ).run(filePath, hash, buffer.length, Date.now(), row.id);

  return db.prepare("SELECT * FROM plugins WHERE id = ?").get(row.id) as unknown as PluginRow;
}

export function readPluginPackage(dataDir: string, pluginName: string, version: string): Buffer | null {
  const safeName = pluginName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = resolve(pluginStorageDir(dataDir));
  const candidate = resolve(join(root, safeName, `${safeVersion}.zip`));
  if (!candidate.startsWith(root + sep)) return null;
  if (!existsSync(candidate)) return null;
  return readFileSync(candidate);
}

/** 与官方 marketplace.json 兼容的目录输出。 */
export function buildMarketplaceJson(db: DatabaseSync) {
  const plugins = listPlugins(db, true);
  const featured = plugins.filter((plugin) => plugin.featured).map((plugin) => plugin.pluginName);
  return {
    name: "zcode-plugins-official",
    description: "ZenithCloud official plugin marketplace.",
    lastUpdated: new Date().toISOString(),
    featured,
    plugins: plugins.map((plugin) => ({
      name: plugin.pluginName,
      version: plugin.version,
      description: plugin.description,
      source: plugin.downloadUrl
        ? { source: "url", url: plugin.downloadUrl }
        : { source: "url", url: `/api/plugins/download/${encodeURIComponent(plugin.pluginName)}/${encodeURIComponent(plugin.version)}` },
      ...(plugin.sha256 ? { sha256: plugin.sha256 } : {}),
      listing: {
        displayName: plugin.displayName,
        icon: plugin.iconUrl || undefined,
        category: plugin.category || undefined,
        publisherType: plugin.publisherType === "community" ? "community" : "official",
        ...(plugin.author ? { author: plugin.author } : {}),
        ...(plugin.homepage ? { homepage: plugin.homepage } : {}),
      },
    })),
  };
}

interface OfficialCatalogEntry {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  source?: unknown;
  listing?: unknown;
}

export async function importOfficialCatalog(
  db: DatabaseSync,
  sourceUrl = OFFICIAL_MARKETPLACE_CDN_URL,
): Promise<{ imported: number; url: string }> {
  let payload: unknown;
  try {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    throw new ZenithError(
      502,
      `拉取官方目录失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const catalog = payload as { plugins?: unknown };
  const entries = Array.isArray(catalog.plugins) ? (catalog.plugins as OfficialCatalogEntry[]) : [];
  let imported = 0;
  for (const entry of entries) {
    const pluginName = readString(entry.name);
    if (!pluginName) continue;
    const listing = (entry.listing ?? {}) as Record<string, unknown>;
    let downloadUrl = "";
    if (typeof entry.source === "string") {
      downloadUrl = entry.source;
    } else if (entry.source && typeof entry.source === "object") {
      const sourceRecord = entry.source as Record<string, unknown>;
      downloadUrl =
        readString(sourceRecord["url"]) ||
        readString(sourceRecord["path"]) ||
        "";
    }
    upsertPlugin(db, {
      pluginName,
      version: readString(entry.version, "latest"),
      displayName: readString(listing["displayName"], pluginName),
      description: readString(entry.description) || readString(listing["description"]),
      category: readString(listing["category"]),
      publisherType: readString(listing["publisherType"]),
      author: readString(listing["author"]),
      iconUrl: readString(listing["icon"]),
      homepage: readString(listing["homepage"]),
      downloadUrl,
      featured: false,
      enabled: true,
    });
    imported += 1;
  }
  return { imported, url: sourceUrl };
}
