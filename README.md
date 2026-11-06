# Matrix Requirements MCP Server

An MCP (Model Context Protocol) server that connects Claude to your [Matrix Requirements](https://matrixreq.com/) ALM
instance. Provides full CRUD access to projects, items, folders, links, labels, TODOs, and document generation.

## Prerequisites

- Node.js 18+
- A Matrix Requirements instance with API access
- An API token (create one in Matrix under User Menu → Access Tokens)

## Setup

### 1. Clone the repository

```bash
git clone git@github.com:Byteflies/matrix-requirements-mcp.git
```

The repository includes the pre-built server (`dist/index.js`), so there is no need to install dependencies or build.

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

### Updating

Pull the latest version and restart Claude (Desktop) or start a new Claude Code session:

```bash
cd $PATH_TO_PROJECT
git pull
```

## HTTP server

To use the server from a client that must not hold the token, for example Claude Code in a sandbox, run it as a separate service that listens over HTTP.

With `MCP_HTTP_PORT` set, the server speaks Streamable HTTP on `http://127.0.0.1:$MCP_HTTP_PORT/mcp` instead of stdio.
It always listens on loopback only.
Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are rejected, so web pages in a local browser cannot reach the server through DNS rebinding.
Anything else running as a local user can call every tool, with the permissions of the token.

[`contrib/matrix-requirements-mcp.service`](contrib/matrix-requirements-mcp.service) is a systemd user service that runs the server on port 8371.
It reads `MATRIX_URL` and `MATRIX_TOKEN` from `~/.secrets/matrix.env`:

```bash
install -d -m 700 ~/.secrets
install -m 600 /dev/null ~/.secrets/matrix.env
$EDITOR ~/.secrets/matrix.env   # MATRIX_URL=https://byteflies.matrixreq.com and MATRIX_TOKEN=<token>
install -m 644 contrib/matrix-requirements-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now matrix-requirements-mcp.service
```

Adjust `ExecStart` in the unit if the repository is not at `~/src/byteflies/matrix-requirements-mcp`.
Then point Claude Code at it, without any token:

```bash
claude mcp add --scope user --transport http matrix-requirements http://127.0.0.1:8371/mcp
```

## Available Tools

### Project & Navigation

| Tool                  | Description                                        |
|-----------------------|----------------------------------------------------|
| `list_projects`       | List all projects on the instance                  |
| `get_project_info`    | Get categories and field definitions for a project |
| `get_folder_tree`     | Get the root folder tree for a project             |
| `get_folder_children` | Get children of a specific folder                  |

### Users & Groups

| Tool          | Description                                                                                  |
|---------------|----------------------------------------------------------------------------------------------|
| `list_groups` | List all user groups; set `details: true` to include members and project permissions (requires ADMIN) |

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

| Tool                   | Description                                                                      |
|------------------------|----------------------------------------------------------------------------------|
| `get_todos`            | Get TODOs for a project                                                          |
| `get_open_trainings`   | Get open training TODOs per user, for one or all projects                        |
| `get_training_changes` | For a user's open trainings, what changed since the version they last trained on |
| `get_audit`            | Get the change/audit log                                                         |

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

`dist/index.js` is committed so end-users don't need to build. On every push to `main`, the `Build dist bundle` GitHub
Actions workflow rebuilds it and commits the result if it changed, so you don't need to commit it yourself.
