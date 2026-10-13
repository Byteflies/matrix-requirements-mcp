#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createConsoleAPI,
  StandaloneMatrixSDK,
  Project,
  Item,
  TreeFolder,
} from "matrix-requirements-sdk/server";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Strip trailing slashes: the SDK appends "/rest/1/", and "//rest" serves the web app's HTML instead of the API.
const MATRIX_URL = process.env.MATRIX_URL?.replace(/\/+$/, "");
const MATRIX_TOKEN = process.env.MATRIX_TOKEN;

if (!MATRIX_URL || !MATRIX_TOKEN) {
  console.error(
    "Error: MATRIX_URL and MATRIX_TOKEN environment variables are required.\n" +
      "  MATRIX_URL   – your Matrix instance URL (e.g. https://clouds5.matrixreq.com)\n" +
      "  MATRIX_TOKEN – your API token (without the 'Token ' prefix)"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The SDK's generated REST client rejects with the raw fetch Response on HTTP errors. It uses
 * node-fetch, whose Response is not the global one, so `instanceof Response` can't be used.
 */
async function describeError(err: unknown): Promise<string> {
  if (err && typeof err === "object" && "status" in err && typeof (err as any).text === "function") {
    const res = err as { status: number; statusText: string; url: string; text(): Promise<string> };
    return `${res.status} ${res.statusText} (${res.url}): ${await res.text()}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Convert rich-text HTML into plain-text paragraphs, one per line, so versions can be diffed. */
function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/?(p|div|br|h[1-6]|tr|ul|ol|table)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && line !== "•" && line !== "|");
}

/**
 * Line-based diff (LCS) rendered as "- removed" / "+ added" lines with one line of context;
 * long unchanged stretches collapse to "…". Returns null when nothing changed.
 */
function diffLines(before: string[], after: string[]): string | null {
  const n = before.length;
  const m = after.length;
  if (n * m > 4_000_000) return `(too large to diff line by line: ${n} lines before, ${m} lines after)`;

  // lcs[i][j] = length of the longest common subsequence of before[i..] and after[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: { kind: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      ops.push({ kind: " ", line: before[i++] });
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ kind: "-", line: before[i++] });
    } else {
      ops.push({ kind: "+", line: after[j++] });
    }
  }
  if (ops.every((op) => op.kind === " ")) return null;

  const isChange = (k: number) => ops[k] !== undefined && ops[k].kind !== " ";
  const out: string[] = [];
  ops.forEach((op, k) => {
    if (isChange(k) || isChange(k - 1) || isChange(k + 1)) out.push(`${op.kind} ${op.line}`);
    else if (out[out.length - 1] !== "…") out.push("…");
  });
  return out.join("\n");
}

let sdk: StandaloneMatrixSDK | null = null;

async function getSDK(): Promise<StandaloneMatrixSDK> {
  if (!sdk) {
    sdk = await createConsoleAPI({
      token: `Token ${MATRIX_TOKEN}`,
      url: MATRIX_URL!,
    }).catch(async (err: unknown) => {
      throw new Error(`Matrix login failed: ${await describeError(err)}`);
    });
  }
  return sdk;
}

async function getProject(projectName: string): Promise<Project> {
  const api = await getSDK();
  const project = await api.openProject(projectName);
  if (!project) {
    throw new Error(`Project '${projectName}' not found or could not be opened.`);
  }
  await api.setProject(projectName);
  return project;
}

/** Set the change reason/comment on the SDK before any write operation. */
async function setReason(reason: string): Promise<void> {
  const api = await getSDK();
  api.setComment(reason);
}

function serializeItem(item: Item): Record<string, unknown> {
  return {
    id: item.getId(),
    type: item.getType(),
    title: item.getTitle(),
    labels: item.getLabels(),
    isFolder: item.isFolder(),
    creationDate: item.getCreationDate(),
    maxVersion: item.getMaxVersion(),
    downlinks: item.getDownlinks(),
    uplinks: item.getUplinks(),
    data: item.extractData(),
  };
}

function serializeFolder(folder: TreeFolder): Record<string, unknown> {
  const children = folder.getAllChildren();
  return {
    id: folder.getId(),
    title: folder.getTitle(),
    path: folder.getPath(),
    isRoot: folder.isRoot(),
    children: children.map((c) => ({
      id: c.id,
      title: c.title,
      isFolder: c.isFolder,
    })),
  };
}

type MatrixField = { id: number; label: string; fieldType: string };

/**
 * Resolve a field label to its config entry for a given item type, using the
 * same case-insensitive label match the Matrix SDK uses (getFieldId). Throws a
 * helpful error listing the available fields when no match is found.
 */
function resolveField(
  proj: Project,
  itemType: string,
  fieldName: string,
  project: string
): MatrixField {
  const fields = (proj.getItemConfig().getFields(itemType) ?? []) as MatrixField[];
  if (fields.length === 0) {
    throw new Error(`No fields found for item type '${itemType}' in project '${project}'.`);
  }
  const target = fields.find((f) => f.label.toLowerCase() === fieldName.toLowerCase());
  if (!target) {
    throw new Error(
      `Field '${fieldName}' not found for item type '${itemType}'. ` +
        `Available fields: ${fields.map((f) => `${f.label} (${f.fieldType})`).join(", ")}`
    );
  }
  return target;
}

/**
 * Write one or more field values via the Matrix REST v1 item PUT.
 *
 * This deliberately bypasses the SDK's setField/setFields path, which has two
 * defects that corrupted earlier description writes:
 *
 *  1. Field values MUST be nested under `itemProperties` (`{ "fx<id>": value }`).
 *     The Matrix server only reads field values from there. The previous raw
 *     PUT placed `fx<id>` at the top level of the body, which the server
 *     silently ignores — so the call returned HTTP 200 ("success") while
 *     writing nothing. That is why every SPEC description came back empty.
 *
 *  2. We never send `linksAreComplete`, so it defaults to 0 (append-only) and
 *     existing up/downlinks are left untouched. The SDK's setFields path
 *     hardcodes `linksAreComplete: 1` while sending no links, which makes the
 *     server treat the complete link set as empty and wipe every trace link.
 *     That is the REQ->SPEC downlink loss seen with set_field.
 *
 * `onlyThoseFields`/`onlyThoseLabels` keep the write scoped to the named fields
 * so no other field or label is disturbed.
 */
async function putItemFields(
  project: string,
  itemId: string,
  fields: Array<{ id: number; value: string }>,
  reason: string
): Promise<void> {
  const itemProperties: Record<string, string> = {};
  for (const f of fields) {
    itemProperties[`fx${f.id}`] = f.value;
  }

  const restUrl = `${MATRIX_URL}/rest/1/${encodeURIComponent(project)}/item/${encodeURIComponent(itemId)}`;
  const response = await fetch(restUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${MATRIX_TOKEN}`,
    },
    body: JSON.stringify({
      reason,
      onlyThoseFields: 1,
      onlyThoseLabels: 1,
      itemProperties,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Matrix REST API returned HTTP ${response.status} when updating fields of '${itemId}': ${errorText}`
    );
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "matrix-requirements",
  version: "1.0.1",
});

// ---- List Projects --------------------------------------------------------

server.tool("list_projects", "List all projects on the Matrix instance", {}, async () => {
  const api = await getSDK();
  const projects = await api.getProjects();
  return {
    content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
  };
});

// ---- List Groups ----------------------------------------------------------

server.tool(
  "list_groups",
  "List all user groups on the Matrix instance, optionally with members and project permissions (details require ADMIN)",
  {
    details: z.boolean().optional().default(false).describe("Include membership and permissions (requires ADMIN)"),
  },
  async ({ details }) => {
    const api = await getSDK();
    // The SDK has no high-level wrapper for groups, so call the generated REST client directly.
    const result = await (api as any).instance.groupGet(details ? 1 : 0).catch(async (err: unknown) => {
      throw new Error(`Matrix API ${await describeError(err)}`);
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result.groups ?? [], null, 2) }],
    };
  }
);

// ---- Get Project Info -----------------------------------------------------

server.tool(
  "get_project_info",
  "Get configuration details for a project including categories and their fields",
  { project: z.string().describe("Project short name (e.g. 'PROJ')") },
  async ({ project }) => {
    const proj = await getProject(project);
    const config = proj.getItemConfig();
    const categories = config.getCategories();
    const result = categories.map((cat: string) => {
      const fields = config.getFields(cat) ?? [];
      return {
        category: cat,
        fields: fields.map((f: any) => ({
          id: f.id,
          label: f.label,
          fieldType: f.fieldType,
        })),
      };
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ---- Browse Folder Tree ---------------------------------------------------

server.tool(
  "get_folder_tree",
  "Get the folder tree for a project. Returns the root folder with all children.",
  { project: z.string().describe("Project short name") },
  async ({ project }) => {
    const proj = await getProject(project);
    const tree = await proj.getProjectTree();
    return {
      content: [{ type: "text", text: JSON.stringify(serializeFolder(tree), null, 2) }],
    };
  }
);

// ---- Get Folder Children --------------------------------------------------

server.tool(
  "get_folder_children",
  "Get the children (sub-folders and items) of a specific folder",
  {
    project: z.string().describe("Project short name"),
    folderId: z.string().describe("Folder ID (e.g. 'F-REQ-1')"),
  },
  async ({ project, folderId }) => {
    const proj = await getProject(project);
    const tree = await proj.getProjectTree();
    const folder = tree.findFolder(folderId);
    if (!folder) {
      throw new Error(`Folder '${folderId}' not found in project '${project}'.`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(serializeFolder(folder), null, 2) }],
    };
  }
);

// ---- Get Item -------------------------------------------------------------

server.tool(
  "get_item",
  "Get a single item by ID, including all fields, links, and labels",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item ID (e.g. 'REQ-1')"),
  },
  async ({ project, itemId }) => {
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    return {
      content: [{ type: "text", text: JSON.stringify(serializeItem(item), null, 2) }],
    };
  }
);

// ---- Search Items ---------------------------------------------------------

server.tool(
  "search_items",
  "Search for items in a project using MRQL or text search. Examples: 'mrql:category=REQ', 'mrql:category=REQ AND title~\"safety\"', or free-text search terms.",
  {
    project: z.string().describe("Project short name"),
    term: z.string().describe("Search term (supports MRQL syntax like 'mrql:category=REQ')"),
  },
  async ({ project, term }) => {
    const proj = await getProject(project);
    const ids = await proj.searchForIds(term);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ matchCount: ids.length, itemIds: ids }, null, 2),
        },
      ],
    };
  }
);

// ---- Search Items with Details --------------------------------------------

server.tool(
  "search_items_with_details",
  "Search for items and return full item details (fields, links, labels). Use for smaller result sets.",
  {
    project: z.string().describe("Project short name"),
    term: z.string().describe("Search term (MRQL or free text)"),
  },
  async ({ project, term }) => {
    const proj = await getProject(project);
    const items = await proj.searchForItems(term);
    const serialized = items.map(serializeItem);
    return {
      content: [{ type: "text", text: JSON.stringify(serialized, null, 2) }],
    };
  }
);

// ---- Create Item ----------------------------------------------------------

server.tool(
  "create_item",
  "Create a new item in a project within a specified folder",
  {
    project: z.string().describe("Project short name"),
    parentFolderId: z.string().describe("Parent folder ID (e.g. 'F-REQ-1')"),
    category: z.string().describe("Category/type of the item (e.g. 'REQ', 'SPEC', 'TC')"),
    title: z.string().describe("Title for the new item"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
    fields: z
      .array(
        z.object({
          fieldName: z.string(),
          value: z.string(),
        })
      )
      .optional()
      .describe("Optional array of field name/value pairs to set on the item"),
  },
  async ({ project, parentFolderId, category, title, reason, fields }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const item = proj.createItem(category);
    item.setTitle(title);

    // Save the item first to create it on the server
    const tree = await proj.getProjectTree();
    const folder = tree.findFolder(parentFolderId);
    if (!folder) {
      throw new Error(`Folder '${parentFolderId}' not found.`);
    }
    const savedItem = await folder.saveInFolder(item);

    // Set fields if provided. Resolve labels to ids and write through the same
    // link-preserving REST PUT used elsewhere, instead of proj.setFields (which
    // nests values incorrectly and wipes links via linksAreComplete:1).
    if (fields && fields.length > 0) {
      const itemType = savedItem.getType();
      const resolved = fields.map((f) => ({
        id: resolveField(proj, itemType, f.fieldName, project).id,
        value: f.value,
      }));
      await putItemFields(project, savedItem.getId(), resolved, reason);
    }

    // Re-fetch to get the updated item
    const finalItem = await proj.getItem(savedItem.getId());
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Item created successfully", item: serializeItem(finalItem) },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Create Folder --------------------------------------------------------

server.tool(
  "create_folder",
  "Create a new folder in a project",
  {
    project: z.string().describe("Project short name"),
    parentFolderId: z.string().describe("Parent folder ID"),
    type: z.string().describe("Category type for the folder (e.g. 'REQ')"),
    title: z.string().describe("Folder title"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, parentFolderId, type, title, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const folder = proj.createFolder(type);
    folder.setTitle(title);

    const tree = await proj.getProjectTree();
    const parentFolder = tree.findFolder(parentFolderId);
    if (!parentFolder) {
      throw new Error(`Parent folder '${parentFolderId}' not found.`);
    }
    const savedFolder = await parentFolder.saveInFolder(folder);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Folder created successfully", folder: serializeItem(savedFolder) },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Update Item Title ----------------------------------------------------

server.tool(
  "update_item_title",
  "Update the title of an existing item",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item ID (e.g. 'REQ-1')"),
    title: z.string().describe("New title"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, title, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    item.setTitle(title);
    const updated = await proj.updateItem(item);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Title updated", item: serializeItem(updated) },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Update Item Description ----------------------------------------------

server.tool(
  "update_item_description",
  "Update the description (richtext) field of an item. Use this instead of set_field when updating description/richtext fields, as it automatically locates the correct field by type rather than relying on an exact label match.",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item ID (e.g. 'REQ-1')"),
    description: z.string().describe("New description content (plain text or HTML)"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
    fieldName: z
      .string()
      .optional()
      .describe(
        "Exact field label to target (optional). When omitted the first richtext field is used."
      ),
  },
  async ({ project, itemId, description, reason, fieldName }) => {
    const proj = await getProject(project);

    // Fetch the item to determine its category/type.
    const item = await proj.getItem(itemId);
    const itemType = item.getType();

    // Locate the target field.
    let targetField: MatrixField;

    if (fieldName) {
      // Explicit label match (case-insensitive), same as the SDK's getFieldId.
      targetField = resolveField(proj, itemType, fieldName, project);
    } else {
      // Auto-detect: first richtext field, then first field whose label
      // contains "description".
      const fields = (proj.getItemConfig().getFields(itemType) ?? []) as MatrixField[];
      if (fields.length === 0) {
        throw new Error(`No fields found for item type '${itemType}' in project '${project}'.`);
      }
      const detected =
        fields.find((f) => f.fieldType === "richtext") ??
        fields.find((f) => f.label.toLowerCase().includes("description"));
      if (!detected) {
        throw new Error(
          `No richtext/description field found for item type '${itemType}'. ` +
            `Available fields: ${fields.map((f) => `${f.label} (${f.fieldType})`).join(", ")}`
        );
      }
      targetField = detected;
    }

    // Write via the corrected REST PUT: nests the value under itemProperties so
    // it is actually persisted, and leaves existing trace links untouched.
    await putItemFields(project, itemId, [{ id: targetField.id, value: description }], reason);

    // Re-fetch so the returned item reflects the new value.
    const updatedItem = await proj.getItem(itemId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "Description updated successfully",
              fieldUsed: `${targetField.label} (id=${targetField.id}, type=${targetField.fieldType})`,
              item: serializeItem(updatedItem),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Set Field ------------------------------------------------------------

server.tool(
  "set_field",
  "Set the value of a specific field on an item",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item ID"),
    fieldName: z.string().describe("Field name"),
    value: z.string().describe("Field value"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, fieldName, value, reason }) => {
    const proj = await getProject(project);
    const itemType = (await proj.getItem(itemId)).getType();
    const field = resolveField(proj, itemType, fieldName, project);

    // Use the link-preserving REST PUT instead of proj.setField. The SDK's
    // setField sends linksAreComplete:1 with no links, which wipes the item's
    // existing trace links on every field write.
    await putItemFields(project, itemId, [{ id: field.id, value }], reason);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ message: "Field updated", itemId, fieldName }, null, 2),
        },
      ],
    };
  }
);

// ---- Set Multiple Fields --------------------------------------------------

server.tool(
  "set_fields",
  "Set multiple field values on an item at once",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item ID"),
    fields: z.array(
      z.object({
        fieldName: z.string(),
        value: z.string(),
      })
    ).describe("Array of field name/value pairs"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, fields, reason }) => {
    const proj = await getProject(project);
    const itemType = (await proj.getItem(itemId)).getType();

    // Resolve every field label to its id, then write through the
    // link-preserving REST PUT (the SDK's setFields wipes trace links).
    const resolved = fields.map((f) => ({
      id: resolveField(proj, itemType, f.fieldName, project).id,
      value: f.value,
    }));
    await putItemFields(project, itemId, resolved, reason);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Fields updated", itemId, fieldsUpdated: fields.length },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Manage Links ---------------------------------------------------------

server.tool(
  "add_downlink",
  "Add a downlink (trace) from one item to another",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Source item ID"),
    targetId: z.string().describe("Target item ID to link to"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, targetId, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    item.addDownlink(targetId);
    const updated = await proj.updateItem(item);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Downlink added", from: itemId, to: targetId },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "remove_downlink",
  "Remove a downlink (trace) from one item to another",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Source item ID"),
    targetId: z.string().describe("Target item ID to unlink"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, targetId, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    item.removeDownlink(targetId);
    const updated = await proj.updateItem(item);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Downlink removed", from: itemId, to: targetId },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Get Links ------------------------------------------------------------

server.tool(
  "get_links",
  "Get all uplinks and downlinks for an item",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item ID"),
  },
  async ({ project, itemId }) => {
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              itemId,
              uplinks: item.getUplinks(),
              downlinks: item.getDownlinks(),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Manage Labels --------------------------------------------------------

server.tool(
  "set_labels",
  "Set labels on an item (replaces existing labels)",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item ID"),
    labels: z.array(z.string()).describe("Array of label strings to set"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, labels, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    item.setLabels(labels);
    const updated = await proj.updateItem(item);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Labels set", itemId, labels: updated.getLabels() },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Delete Item ----------------------------------------------------------

server.tool(
  "delete_item",
  "Delete an item or folder from a project. For non-empty folders, set force=true.",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Item or folder ID to delete"),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Force delete non-empty folders"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, force, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const result = await proj.deleteItem(itemId, force);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ message: "Item deleted", itemId, result }, null, 2),
        },
      ],
    };
  }
);

// ---- Move Items -----------------------------------------------------------

server.tool(
  "move_items",
  "Move one or more items to a different folder",
  {
    project: z.string().describe("Project short name"),
    folderId: z.string().describe("Destination folder ID"),
    itemIds: z.array(z.string()).describe("Array of item IDs to move"),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, folderId, itemIds, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const result = await proj.moveItems(folderId, itemIds);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Items moved", folderId, itemIds, result },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Get TODOs ------------------------------------------------------------

server.tool(
  "get_todos",
  "Get TODOs for a project, optionally filtered by item",
  {
    project: z.string().describe("Project short name"),
    itemRef: z.string().optional().describe("Optional item reference to filter by"),
    includeDone: z.boolean().optional().default(false).describe("Include completed TODOs"),
    includeAllUsers: z.boolean().optional().default(false).describe("Include TODOs for all users"),
  },
  async ({ project, itemRef, includeDone, includeAllUsers }) => {
    const proj = await getProject(project);
    const todos = await proj.getTodos(itemRef, includeDone, includeAllUsers);
    return {
      content: [{ type: "text", text: JSON.stringify(todos, null, 2) }],
    };
  }
);

// ---- Get Open Trainings ---------------------------------------------------

/** Link to the item in the live QMS (published) view, where users read documents and confirm training. */
function liveQmsUrl(project: string, itemRef: string, login: string): string {
  const query = new URLSearchParams({ USER: login, show: itemRef });
  return `${MATRIX_URL}/pub/${encodeURIComponent(project)}?${query}`;
}

/** The server puts a todo's type and text under `action`, not at the top level as the SDK types suggest. */
function isTraining(todo: any): boolean {
  return todo.action?.todoType === "needTraining";
}

/**
 * Fetch open training todos for all users, in one project or across all projects. Per-project
 * failures are recorded in `errors` so one inaccessible project doesn't fail the whole scan.
 */
async function fetchOpenTrainings(
  api: StandaloneMatrixSDK,
  project: string | undefined,
  includeFuture: boolean,
  errors: Record<string, string>
): Promise<any[]> {
  const projects = project ? [project] : await api.getProjects();
  const results = await Promise.all(
    projects.map(async (p) => {
      try {
        // Call the REST client directly so we don't have to open (and load the config of) every project.
        const ack = await (api as any).instance.projectTodoGet(p, undefined, 0, 1, includeFuture ? 1 : 0);
        return (ack.todos ?? []) as any[];
      } catch (err: unknown) {
        errors[p] = await describeError(err);
        return [];
      }
    })
  );
  return results.flat().filter(isTraining);
}

server.tool(
  "get_open_trainings",
  "Get open training TODOs (needTraining) grouped by user, for one project or all projects (other users' trainings may require ADMIN)",
  {
    project: z.string().optional().describe("Project short name; omit to scan all projects"),
    login: z.string().optional().describe("Only return trainings for this user login (returns full details with title and URL; otherwise a per-user count and item list)"),
    includeFuture: z.boolean().optional().default(false).describe("Include trainings scheduled for a future date"),
  },
  async ({ project, login, includeFuture }) => {
    const api = await getSDK();
    const errors: Record<string, string> = {};
    const trainings = await fetchOpenTrainings(api, project, includeFuture, errors);

    const byUser: Record<string, any[]> = {};
    for (const todo of trainings) {
      if (login && todo.login !== login) continue;
      (byUser[todo.login ?? "unknown"] ??= []).push(todo);
    }

    // Look up titles with one tree call per project that has trainings, rather than one call per item.
    const titles = new Map<string, string>();
    if (login) {
      const trainingProjects = [...new Set(Object.values(byUser).flat().map((t) => t.projectShort as string))];
      await Promise.all(
        trainingProjects.map(async (p) => {
          try {
            // "yes" requests the fancy tree (id/title/children), which is what the SDK itself uses.
            const tree = await (api as any).instance.projectTreeGet(p, "yes");
            const walk = (nodes: any[] = []) => {
              for (const node of nodes) {
                // Titles come back HTML-escaped (e.g. "&amp;").
                if (node.id && node.title) titles.set(`${p}/${node.id}`, decodeHtmlEntities(node.title));
                walk(node.children);
              }
            };
            walk(tree);
          } catch (err: unknown) {
            errors[p] = `titles unavailable: ${await describeError(err)}`;
          }
        })
      );
    }

    // Instance-wide there can be thousands of open trainings, so only return full details for a single user.
    const users = Object.fromEntries(
      Object.entries(byUser)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([user, todos]) => [
          user,
          login
            ? todos.map((t) => ({
                todoId: t.todoId,
                project: t.projectShort,
                itemRef: t.itemRef,
                title: titles.get(`${t.projectShort}/${t.itemRef}`),
                url: `${MATRIX_URL}/${t.projectShort}/${t.itemRef}`,
                liveQmsUrl: liveQmsUrl(t.projectShort, t.itemRef, user),
                text: t.action?.text,
                createdAt: t.createdAt,
                future: t.future,
              }))
            : { count: todos.length, items: todos.map((t) => `${t.projectShort}/${t.itemRef}`) },
        ])
    );

    const summary = {
      totalOpen: Object.values(byUser).reduce((n, list) => n + list.length, 0),
      // In summary mode, an item's URL is `${baseUrl}/${item}` (e.g. QMS/WI-543).
      ...(login ? {} : { baseUrl: MATRIX_URL }),
      byUser: users,
      ...(Object.keys(errors).length ? { errors } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ---- Get Training Changes -------------------------------------------------

const TEXT_FIELD_TYPES = new Set(["richtext", "text", "textline"]);

/** Text fields of a REST item; type and name come from the project config, as the REST response may omit them. */
function textFields(item: any, config: Map<number, MatrixField>): { name: string; lines: string[] }[] {
  return ((item.fieldValList?.fieldVal ?? []) as any[])
    .filter((f) => TEXT_FIELD_TYPES.has(config.get(f.id)?.fieldType ?? f.fieldType) && f.value)
    .map((f) => ({ name: config.get(f.id)?.label ?? f.fieldName ?? `field ${f.id}`, lines: htmlToLines(f.value) }));
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n… (truncated, ${text.length - maxChars} more characters; raise maxChars to see more)`;
}

/**
 * Compare the item as released for the open training (its state when the todo was created) against
 * the item as released for the user's last completed training on it. Using the todos' creation dates
 * rather than the live item excludes draft edits made after the release.
 */
async function buildTrainingChanges(rest: any, todo: any, login: string, maxChars: number) {
  const project = todo.projectShort;
  const ref = todo.itemRef;
  const category = ref.replace(/-\d+$/, "");
  const fields = (await getProject(project)).getItemConfig().getFields(category) as MatrixField[] | undefined;
  const config = new Map((fields ?? []).map((f) => [f.id, f]));
  const [current, itemTodos, target] = await Promise.all([
    rest.projectItemItemGet(project, ref, 1),
    rest.projectTodoGet(project, ref, 1, 1, 0),
    rest.projectItemItemGet(project, ref, 0, 0, undefined, todo.createdAt),
  ]);

  const versions = ((current.itemHistoryList?.itemHistory ?? []) as any[]).sort((a, b) => a.version - b.version);
  const versionAt = (date: string) => versions.filter((v) => v.createdAt <= date).at(-1)?.version;
  const toVersion = versionAt(todo.createdAt);

  const training = {
    project,
    itemRef: ref,
    title: decodeHtmlEntities(target.title ?? current.title ?? ""),
    url: `${MATRIX_URL}/${project}/${ref}`,
    liveQmsUrl: liveQmsUrl(project, ref, login),
    assignedAt: todo.createdAt,
    version: toVersion,
  };

  const previous = ((itemTodos.todos ?? []) as any[])
    .filter((t) => isTraining(t) && t.login === login && t.closedAt && t.createdAt < todo.createdAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);

  if (!previous) {
    const content = textFields(target, config)
      .map((f) => `## ${f.name}\n${f.lines.join("\n")}`)
      .join("\n\n");
    return {
      ...training,
      lastTrainedOn: null,
      note: "No earlier completed training on this item, so this is a first training: the whole content is new.",
      content: truncate(content, maxChars),
    };
  }

  const baseline = await rest.projectItemItemGet(project, ref, 0, 0, undefined, previous.createdAt);
  const fromVersion = versionAt(previous.createdAt);

  const before = new Map(textFields(baseline, config).map((f) => [f.name, f.lines]));
  const changes: string[] = [];
  const targetFields = textFields(target, config);
  for (const field of targetFields) {
    const diff = diffLines(before.get(field.name) ?? [], field.lines);
    before.delete(field.name);
    if (diff) changes.push(`## ${field.name}\n${diff}`);
  }
  for (const [name, lines] of before) {
    changes.push(`## ${name} (field removed)\n${lines.map((line) => `- ${line}`).join("\n")}`);
  }

  return {
    ...training,
    lastTrainedOn: { assignedAt: previous.createdAt, completedAt: previous.closedAt, version: fromVersion },
    changeLog: versions
      .filter((v) => fromVersion !== undefined && v.version > fromVersion && toVersion !== undefined && v.version <= toVersion)
      .map((v) => ({ version: v.version, date: v.createdAt, by: v.createdByUserLogin, reason: v.reason })),
    textFieldsCompared: targetFields.length,
    changes: changes.length
      ? truncate(changes.join("\n\n"), maxChars)
      : "No text changes; the new version may only differ in links, labels or non-text fields.",
  };
}

server.tool(
  "get_training_changes",
  "For a user's open trainings (oldest first), return what changed in each document since the version the user " +
    "last trained on: the change log of versions in between and a paragraph-level diff of the text fields " +
    "('-' removed, '+' added, '…' unchanged text skipped). If there is no earlier training, returns the content " +
    "instead. Each training has a liveQmsUrl: the live QMS view where the user reads the document and confirms " +
    "the training. Page with assignedAfter = the previous call's nextAssignedAfter.",
  {
    login: z.string().describe("User login whose open trainings to compare"),
    project: z.string().optional().describe("Project short name; omit to scan all projects"),
    itemRef: z.string().optional().describe("Only this item (e.g. PROC-162)"),
    limit: z.number().int().min(1).max(20).optional().default(5).describe("Number of trainings to process"),
    assignedAfter: z
      .string()
      .optional()
      .describe("Only trainings assigned after this ISO timestamp; pass the previous call's nextAssignedAfter to page"),
    maxChars: z.number().int().min(500).optional().default(8000).describe("Truncate each item's changes/content to this many characters"),
  },
  async ({ login, project, itemRef, limit, assignedAfter, maxChars }) => {
    const api = await getSDK();
    const rest = (api as any).instance;
    const errors: Record<string, string> = {};

    const open = (await fetchOpenTrainings(api, project, false, errors))
      .filter((t) => t.login === login && (!itemRef || t.itemRef === itemRef))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Page by assignment date rather than position: completing a training between calls would shift positions.
    const pending = assignedAfter ? open.filter((t) => t.createdAt > assignedAfter) : open;
    const batch = pending.slice(0, limit);

    const trainings = await Promise.all(
      batch.map(async (todo) => {
        try {
          return await buildTrainingChanges(rest, todo, login, maxChars);
        } catch (err: unknown) {
          return { project: todo.projectShort, itemRef: todo.itemRef, error: await describeError(err) };
        }
      })
    );

    const result = {
      login,
      totalOpen: open.length,
      remaining: pending.length - batch.length,
      ...(pending.length > batch.length ? { nextAssignedAfter: batch[batch.length - 1].createdAt } : {}),
      trainings,
      ...(Object.keys(errors).length ? { errors } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ---- Generate Document ----------------------------------------------------

server.tool(
  "generate_document",
  "Export a DOC item to PDF, HTML, DOCX, or ODT format",
  {
    project: z.string().describe("Project short name"),
    docId: z.string().describe("DOC item ID"),
    format: z.enum(["pdf", "html", "docx", "odt"]).describe("Output format"),
  },
  async ({ project, docId, format }) => {
    const proj = await getProject(project);
    const result = await proj.generateDocument(format, docId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: `Document generated as ${format}`, result },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Get Test Steps Config ------------------------------------------------

server.tool(
  "get_test_steps_config",
  "Get the column configuration for test case steps in a project. Call this before set_test_steps to discover the available column field names (e.g. 'action', 'expected', etc.).",
  {
    project: z.string().describe("Project short name"),
    category: z.string().describe("Test case category (e.g. 'TC')"),
  },
  async ({ project, category }) => {
    const proj = await getProject(project);
    const testConfig = proj.getTestConfig();
    const stepsConfig = testConfig.getTestStepsConfig(category);
    return {
      content: [{ type: "text", text: JSON.stringify(stepsConfig, null, 2) }],
    };
  }
);

// ---- Get Test Steps -------------------------------------------------------

server.tool(
  "get_test_steps",
  "Get the test case steps from a TC item as a structured array",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Test case item ID (e.g. 'TC-1')"),
  },
  async ({ project, itemId }) => {
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    const itemType = item.getType();

    const testConfig = proj.getTestConfig();
    const stepsConfig = testConfig.getTestStepsConfig(itemType);
    const columns = (stepsConfig?.columns ?? []) as Array<{ name: string; field: string }>;

    const stepsFields = item.getFieldsByType("test_steps");
    if (stepsFields.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { message: "No test steps field found for this item", itemType },
              null,
              2
            ),
          },
        ],
      };
    }

    const handler = stepsFields[0].getHandler<any>();
    const rowCount = handler.getRowCount();
    const steps: Record<string, string>[] = [];
    for (let row = 0; row < rowCount; row++) {
      const step: Record<string, string> = {};
      for (const col of columns) {
        step[col.field] = handler.getColumnData(row, col.field) ?? "";
      }
      steps.push(step);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ itemId, itemType, columnConfig: columns, steps }, null, 2),
        },
      ],
    };
  }
);

// ---- Set Test Steps -------------------------------------------------------

server.tool(
  "set_test_steps",
  "Set (replace) test case steps on a TC item. Each step is an object whose keys are column field names — call get_test_steps_config first to discover those names. All existing steps are replaced.",
  {
    project: z.string().describe("Project short name"),
    itemId: z.string().describe("Test case item ID (e.g. 'TC-1')"),
    steps: z
      .array(z.record(z.string(), z.string()))
      .describe(
        "Array of step objects. Keys are column field names (from get_test_steps_config). " +
          "Example: [{\"action\": \"Open the app\", \"expected\": \"App opens successfully\"}]"
      ),
    reason: z.string().describe("Change reason/comment (required by Matrix for audit trail)"),
  },
  async ({ project, itemId, steps, reason }) => {
    await setReason(reason);
    const proj = await getProject(project);
    const item = await proj.getItem(itemId);
    const itemType = item.getType();

    // Retrieve the test steps column configuration for this category.
    const testConfig = proj.getTestConfig();
    const stepsConfig = testConfig.getTestStepsConfig(itemType);
    const columns = (stepsConfig?.columns ?? []) as Array<{ name: string; field: string }>;

    if (columns.length === 0) {
      throw new Error(
        `No test steps columns configured for category '${itemType}' in project '${project}'. ` +
          "Ensure the category is a test case type."
      );
    }

    // Locate the test steps field handler.
    const stepsFields = item.getFieldsByType("test_steps");
    if (stepsFields.length === 0) {
      throw new Error(
        `No 'test_steps' field found on item '${itemId}' (type '${itemType}'). ` +
          "Verify the item is a test case with a Steps field."
      );
    }

    const handler = stepsFields[0].getHandler<any>();

    // Replace all existing steps with the new ones.
    handler.clear();
    steps.forEach((step, rowIndex) => {
      // Map each column field to its value (default to empty string if not provided).
      const columnData = columns.map((col) => step[col.field] ?? "");
      handler.insertRow(rowIndex, columnData);
    });

    // Persist: updateItem serialises all field handlers via extractData().
    const updatedItem = await proj.updateItem(item);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "Test steps set successfully",
              itemId,
              stepsCount: steps.length,
              columns: columns.map((c) => c.field),
              item: serializeItem(updatedItem),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Get Audit Log --------------------------------------------------------

server.tool(
  "get_audit",
  "Get the audit/change log for a project",
  {
    project: z.string().describe("Project short name"),
    maxResults: z.number().optional().default(50).describe("Maximum number of results"),
    itemRef: z.string().optional().describe("Optional item ID to filter audit entries"),
  },
  async ({ project, maxResults, itemRef }) => {
    const proj = await getProject(project);
    const audit = await proj.getAudit(
      undefined,
      maxResults,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      itemRef
    );
    return {
      content: [{ type: "text", text: JSON.stringify(audit, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Matrix Requirements MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
