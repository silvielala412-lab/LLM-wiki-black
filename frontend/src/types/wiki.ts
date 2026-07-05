export interface WikiProject {
  /** Stable UUID, persisted inside the project at .llm-wiki/project.json.
   *  Survives the user moving or renaming the project folder. */
  id: string
  name: string
  path: string
  /** Optional per-project knowledge chunking customization */
  chunking?: ChunkingConfig
}

/** Per-project knowledge chunking preferences.
 *  Stored in .llm-wiki/project.json under the "chunking" key.
 */
export interface ChunkingConfig {
  /** Master toggle — when false, all other fields are ignored */
  enabled: boolean
  /** Knowledge granularity: how finely to slice concepts into pages */
  granularity: "fine" | "standard" | "coarse"
  /** Writing style for generated wiki pages */
  style: "academic" | "engineering" | "bullet_points" | "narrative"
  /** Whether each knowledge concept MUST include a code/usage example */
  include_examples: boolean
  /** Whether to include citation/reference annotations */
  include_references: boolean
  /** Free-text user instruction appended to the LLM system prompt */
  custom_instruction: string
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  enabled: false,
  granularity: "standard",
  style: "engineering",
  include_examples: false,
  include_references: false,
  custom_instruction: "",
}

export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
}

export interface WikiPage {
  path: string
  content: string
  frontmatter: Record<string, unknown>
}
