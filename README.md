# Matrix Requirements MCP Server

An MCP (Model Context Protocol) server that connects Claude to your [Matrix Requirements](https://matrixreq.com/) ALM
instance. Provides full CRUD access to projects, items, folders, links, labels, TODOs, and document generation.

## Prerequisites

- Node.js 18+
- A Matrix Requirements instance with API access
- An API token (create one in Matrix under User Menu → Access Tokens)

## Setup

### 1. Install dependencies and build

```bash
npm install
npm run build
```

### 2. Configuration Variables

To configure the server you need the following variables at hand:

| Variable          | Description                            | Example                                      |
|-------------------|----------------------------------------|----------------------------------------------|
| `MATRIX_URL`      | Matrix instance URL                    | `https://byteflies.matrixreq.com`            |
| `MATRIX_TOKEN`    | Your personal API token                | `api_XXXXXXXXXXXXXXXXXXXXXXXXXXX`            |
| `PATH_TO_PROJECT` | Path on your machine to the repository | `/my/home/directory/matrix-requirements-mcp` |

#### MATRIX_URL

Fixed to the Byteflies Matrix Requirements instance `https://byteflies.matrixreq.com`.

#### MATRIX_TOKEN

You need to create your own Matrix API token. Click on your initials in the top-right-hand corner and select 'My
Tokens'. Choose a 'Valid Until' date and a fitting description (e.g. 'MCP server'), and click Create. Copy the token
value.

#### PATH_TO_PROJECT

The absolute path to the directory where you cloned this repository on your machine. Make sure to include the leading
'/' and leave out the trailing '/'.

### Configure MCP server in Claude

#### 3a. Add to Claude Desktop

Replace the configuration variables with your values in the following JSON snippet and add it to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "matrix-requirements": {
      "command": "node",
      "args": [
        "$PATH_TO_PROJECT/dist/index.js"
      ],
      "env": {
        "MATRIX_URL": "$MATRIX_URL",
        "MATRIX_TOKEN": "$MATRIX_TOKEN"
      }
    }
  }
}
```

#### 3b. Add to Claude Code

Execute the following bash command to add the MCP server to Claude Code (**replace** the configuration variables with
your values):

```bash
claude mcp add matrix-requirements \
  --scope user \
  -e MATRIX_URL=$MATRIX_URL \
  -e MATRIX_TOKEN=$MATRIX_TOKEN \
  -- node $PATH_TO_PROJECT/dist/index.js
```

**Note:** `--scope user` makes the MCP available to all projects on your machine. Omitting it only registers it for the
project (directory) you are currently in.

## Available Tools

### Project & Navigation

| Tool                  | Description                                        |
|-----------------------|----------------------------------------------------|
| `list_projects`       | List all projects on the instance                  |
| `get_project_info`    | Get categories and field definitions for a project |
| `get_folder_tree`     | Get the root folder tree for a project             |
| `get_folder_children` | Get children of a specific folder                  |

### Items (CRUD)

| Tool                        | Description                                          |
|-----------------------------|------------------------------------------------------|
| `get_item`                  | Get a single item with all fields, links, and labels |
| `search_items`              | Search items by MRQL or free text (returns IDs)      |
| `search_items_with_details` | Search items with full details returned              |
| `create_item`               | Create a new item in a folder                        |
| `update_item_title`         | Update an item's title                               |
| `set_field`                 | Set a single field value                             |
| `set_fields`                | Set multiple field values at once                    |
| `delete_item`               | Delete an item or folder                             |
| `move_items`                | Move items to a different folder                     |

### Folders

| Tool            | Description                      |
|-----------------|----------------------------------|
| `create_folder` | Create a new folder in a project |

### Links (Traceability)

| Tool              | Description                               |
|-------------------|-------------------------------------------|
| `get_links`       | Get all uplinks and downlinks for an item |
| `add_downlink`    | Add a trace link between items            |
| `remove_downlink` | Remove a trace link between items         |

### Labels

| Tool         | Description           |
|--------------|-----------------------|
| `set_labels` | Set labels on an item |

### TODOs & Audit

| Tool        | Description              |
|-------------|--------------------------|
| `get_todos` | Get TODOs for a project  |
| `get_audit` | Get the change/audit log |

### Document Generation

| Tool                | Description                             |
|---------------------|-----------------------------------------|
| `generate_document` | Export a DOC to PDF, HTML, DOCX, or ODT |

## MRQL Search Syntax

Matrix uses MRQL for structured queries. Examples:

- `mrql:category=REQ` — all requirements
- `mrql:category=REQ AND title~"safety"` — requirements with "safety" in title
- `mrql:category=TC AND label=approved` — approved test cases
- Free text searches also work (just pass a search string)

## Development

```bash
npm run dev    # Watch mode - recompiles on changes
npm run build  # One-time build
npm start      # Run the server
```
