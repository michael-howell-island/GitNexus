/**
 * MCP Tool Definitions
 *
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        default?: any;
        items?: { type: string };
        enum?: string[];
      }
    >;
    required: string[];
  };
}

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List all indexed repositories. Returns name, path, indexed date, last commit, and stats. When multiple repos exist, specify "repo" on other tools to target the correct one.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept. Returns processes (call chains) ranked by relevance with symbols and file locations. Use context() on a specific symbol for deeper analysis.

Results: processes (ranked flows), process_symbols (symbols with locations and module), definitions (standalone types). Hybrid BM25 + semantic ranking.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: {
          type: 'string',
          description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.',
        },
        goal: {
          type: 'string',
          description:
            'What you want to find (e.g., "existing auth validation logic"). Helps ranking.',
        },
        limit: { type: 'number', description: 'Max processes to return (default: 5)', default: 5 },
        max_symbols: {
          type: 'number',
          description: 'Max symbols per process (default: 10)',
          default: 10,
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'cypher',
    description: `Execute Cypher query against the code knowledge graph. READ gitnexus://repo/{name}/schema for full schema.

Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process, Route, Tool. Multi-lang: \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\` (backticks).
Edges: all via CodeRelation with 'type' property — CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, FETCHES, HANDLES_TOOL, ENTRY_POINT_OF.
Edge props: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32).

Examples (cover all major patterns):
• Callers: MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath
• Community members: MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name
• Process trace: MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step
• Class methods: MATCH (c:Class {name: "UserService"})-[:CodeRelation {type: 'HAS_METHOD'}]->(m:Method) RETURN m.name
• Field writers: MATCH (f:Function)-[:CodeRelation {type: 'ACCESSES', reason: 'write'}]->(p:Property) WHERE p.name = "address" RETURN f.name
• Method overrides: MATCH (winner:Method)-[r:CodeRelation {type: 'METHOD_OVERRIDES'}]->(loser:Method) RETURN winner.name, r.reason
• Class properties: MATCH (c:Class {name: "User"})-[:CodeRelation {type: 'HAS_PROPERTY'}]->(p:Property) RETURN p.name, p.declaredType
• Diamond inheritance: MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1), (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2), (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a), (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a) WHERE b1 <> b2 RETURN d.name, b1.name, b2.name, a.name

Community = auto-detected functional area (heuristicLabel, cohesion, symbolCount, keywords). Process = execution flow (heuristicLabel, processType, stepCount). Use heuristicLabel (not label). Returns { markdown, row_count }.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a code symbol: callers, callees, imports, extends, methods, properties, overrides, process participation, and file location. Disambiguates common names (use uid for zero-ambiguity). ACCESSES edges included with reason 'read' or 'write'. CALLS resolve through field access chains (e.g. user.address.getCity()). Use impact() if planning changes.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)',
        },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows. Maps diff hunks to symbols, traces impacted processes. Returns changed symbols, affected processes, and risk summary.

GIT WORKTREE SUPPORT: "repo" now resolves a linked worktree's path to the repo indexed at its main checkout (or vice versa) instead of failing with "not found". GitNexus also auto-detects when this process is running from inside a linked worktree of the indexed repo and runs git diff there. Pass "worktree" explicitly only when auto-detection can't see your actual working directory (e.g. a long-lived server launched from a different directory than the worktree you're editing).`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          default: 'unstaged',
        },
        base_ref: {
          type: 'string',
          description: 'Branch/commit for "compare" scope (e.g., "main")',
        },
        worktree: {
          type: 'string',
          description:
            'Absolute path to a linked git worktree. Pass this when your changes are in a worktree and auto-detection did not pick it up.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using knowledge graph + text search. Preview by default (dry_run=true). Edits tagged "graph" (high confidence) or "text_search" (review carefully). Run detect_changes() after to verify.`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity)',
        },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: {
          type: 'boolean',
          description: 'Preview edits without modifying files (default: true)',
          default: true,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Blast radius analysis for a code symbol. Returns risk (LOW–CRITICAL), affected symbols by depth (d=1: WILL BREAK, d=2: LIKELY AFFECTED, d=3: MAY NEED TESTING), affected processes, and affected modules.

Use before refactoring or modifying shared code. Default traversal: CALLS/IMPORTS/EXTENDS/IMPLEMENTS. Add HAS_METHOD/HAS_PROPERTY for class members, ACCESSES for field analysis.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        direction: {
          type: 'string',
          description: 'upstream (what depends on this) or downstream (what this depends on)',
        },
        maxDepth: {
          type: 'number',
          description: 'Max relationship depth (default: 3)',
          default: 3,
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES (default: usage-based, ACCESSES excluded by default)',
        },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: { type: 'number', description: 'Minimum confidence 0-1 (default: 0.7)' },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['target', 'direction'],
    },
  },
  {
    name: 'route_map',
    description: `Show API route mappings: handlers, middleware chains, and consumers. For pre-change analysis, prefer api_impact. Use impact() on route handlers for full blast radius.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Filter by route path (e.g., "/api/grants"). Omit for all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'tool_map',
    description: `Show MCP/RPC tool definitions: which tools are defined, where they're handled, and their descriptions.

WHEN TO USE: Understanding tool APIs, finding tool implementations, impact analysis for tool changes.

Returns: tool nodes with their handler files and descriptions.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Filter by tool name. Omit for all tools.' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'shape_check',
    description: `Check API response shapes against consumer property accesses. Detects mismatches where consumers access keys not in the route's response. For pre-change analysis, prefer api_impact.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Check a specific route (e.g., "/api/grants"). Omit to check all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'api_impact',
    description: `Pre-change impact report for an API route handler. Shows consumers, response fields accessed, middleware, and execution flows. Risk: LOW (0-3 consumers), MEDIUM (4-9 or mismatches), HIGH (10+). Requires "route" or "file" param.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Route path (e.g., "/api/grants")' },
        file: { type: 'string', description: 'Handler file path (alternative to route)' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'group_list',
    description: `List all configured repository groups, or return details for one group (repos, manifest links).

WHEN TO USE: Discover groups before group_sync. Optional "name" returns a single group's config.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name. Omit to list all groups.' },
      },
      required: [],
    },
  },
  {
    name: 'group_sync',
    description: `Rebuild the Contract Registry (contracts.json) for a group: extract HTTP contracts, apply manifest links, exact-match cross-links.

WHEN TO USE: After changing group.yaml or re-indexing member repos.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        skipEmbeddings: {
          type: 'boolean',
          description: 'Exact + BM25 only (Demo PR: same as default exact path)',
        },
        exactOnly: { type: 'boolean', description: 'Exact match only in cascade' },
      },
      required: ['name'],
    },
  },
  {
    name: 'group_contracts',
    description: `Inspect contracts and cross-links from the group's contracts.json.

WHEN TO USE: Debug cross-repo links after group_sync.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        type: { type: 'string', description: 'Filter by contract type (http, topic, …)' },
        repo: { type: 'string', description: 'Filter by group repo path (e.g. app/backend)' },
        unmatchedOnly: { type: 'boolean', description: 'Only contracts with no cross-link' },
      },
      required: ['name'],
    },
  },
  {
    name: 'group_query',
    description: `Run the query tool across all repos in a group and merge process results via reciprocal rank fusion.

WHEN TO USE: Semantic / hybrid search across a whole product group.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        query: { type: 'string', description: 'Search query' },
        subgroup: { type: 'string', description: 'Limit to repo paths under this prefix' },
        limit: { type: 'number', description: 'Max merged results (default 5)' },
      },
      required: ['name', 'query'],
    },
  },
  {
    name: 'group_status',
    description: `Report index staleness (commit vs HEAD) and Contract Registry staleness (indexedAt) for each repo in a group.

WHEN TO USE: Before group_sync or when agents should refresh indexes.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
      },
      required: ['name'],
    },
  },
];
