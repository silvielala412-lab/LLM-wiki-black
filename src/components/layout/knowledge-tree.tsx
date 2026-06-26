import React, { useState, useEffect, useCallback, useRef } from "react"
import { FileText, Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, ChevronRight, ChevronDown, Layout, Globe, ShieldCheck, CalendarClock, BriefcaseBusiness, Network, FolderOpen, Package } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { SERVICE_HIERARCHY } from "@/lib/insurance-schema-registry"
import { INSURANCE_CATEGORIES, type InsuranceCategoryType } from "@/lib/product-catalog-modules"
import { getQueueSummary } from "@/lib/ingest-queue"

interface WikiPageInfo {
  path: string; title: string; type: string; domain: string; tags: string[]; origin?: string
  lineName?: string; versionName?: string
}

const TYPE_CONFIG: Record<string, { icon: typeof FileText; label: string; color: string; order: number }> = {
  overview:   { icon: Layout,    label: "Overview",    color: "text-yellow-500", order: 0 },
  entity:     { icon: Users,     label: "Entities",    color: "text-blue-500",   order: 1 },
  concept:    { icon: Lightbulb, label: "Concepts",    color: "text-purple-500", order: 2 },
  source:     { icon: BookOpen,  label: "Sources",     color: "text-orange-500", order: 3 },
  synthesis:  { icon: GitMerge,  label: "Synthesis",   color: "text-red-500",    order: 4 },
  comparison: { icon: BarChart3, label: "Comparisons", color: "text-emerald-500",order: 5 },
  query:      { icon: HelpCircle,label: "Queries",     color: "text-green-500",  order: 6 },
}
const DEFAULT_CONFIG = { icon: FileText, label: "Other", color: "text-muted-foreground", order: 99 }

/** Match entity to a service line/version via multiple methods. */
function detectHierarchy(page: WikiPageInfo): { lineName: string; versionName: string } | null {
  // 1. Path: wiki/entities/{line}/{version}/file.md
  const pm = normalizePath(page.path).match(/\/wiki\/entities\/([^/]+)\/([^/]+)\/[^/]+\.md$/)
  if (pm) return { lineName: pm[1], versionName: pm[2] }
  // 2. Frontmatter fields already parsed
  if (page.lineName && page.versionName) return { lineName: page.lineName, versionName: page.versionName }
  // 3. Title or file basename prefix — check both "-" and "_" separators
  const basename = page.path.split("/").pop()?.replace(/\.md$/i, "") ?? ""
  for (const ser of SERVICE_HIERARCHY) {
    for (const sc of ser.scenarios) {
      for (const ln of sc.lines) {
        for (const vn of ln.versions) {
          const hyphen  = `${ln.lineName}-${vn.versionName}-`
          const under   = `${ln.lineName}_${vn.versionName}_`
          const hyphen2 = `${ln.lineName}-${vn.versionName}`   // exact match (version summary page)
          const under2  = `${ln.lineName}_${vn.versionName}`   // exact match underscore
          if (
            page.title.startsWith(hyphen)  || page.title.startsWith(under)  ||
            page.title === hyphen2         || page.title === under2          ||
            basename.startsWith(hyphen)    || basename.startsWith(under)     ||
            // File is named like "service_{line}_{version}_{title}.md"
            basename.startsWith(`service_${ln.lineName}_${vn.versionName}_`)
          ) {
            return { lineName: ln.lineName, versionName: vn.versionName }
          }
        }
      }
    }
  }
  return null
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase()
}

function pageMatchesSearch(page: WikiPageInfo, query: string): boolean {
  if (!query) return true
  return [
    page.title,
    page.path,
    page.type,
    page.domain,
    page.origin ?? "",
    page.lineName ?? "",
    page.versionName ?? "",
    ...page.tags,
  ].some(value => value.toLowerCase().includes(query))
}

export function KnowledgeTree({ searchQuery = "" }: { searchQuery?: string }) {
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const fileTree = useWikiStore((s) => s.fileTree)
  const dataVersion = useWikiStore((s) => s.dataVersion)

  const [pages, setPages] = useState<WikiPageInfo[]>([])
  const [groupMode, setGroupMode] = useState<"type" | "service" | "product">("type")
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(["overview", "entity", "concept", "source"]))
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set(SERVICE_HIERARCHY.map(s => s.seriesName)))
  const [expandedScenarios, setExpandedScenarios] = useState<Set<string>>(new Set())
  const [expandedLines, setExpandedLines] = useState<Set<string>>(new Set())
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set())
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set())
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  // Product catalog: list of files in wiki/product_catalog/
  const [productCatalogPages, setProductCatalogPages] = useState<WikiPageInfo[]>([])
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set())
  const queueWasActiveRef = useRef(false)

  const loadProductCatalogPages = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const pcTree = await listDirectory(`${pp}/wiki/product_catalog`)
      const pcInfos = flattenMdFiles(pcTree).map(f => parseInfo(f.path, f.name, ""))
      setProductCatalogPages(pcInfos)
      setPages(prev => [...prev.filter(p => !isProductCatalogPath(p.path)), ...pcInfos])
    } catch {
      setProductCatalogPages([])
      setPages(prev => prev.filter(p => !isProductCatalogPath(p.path)))
    }
  }, [project])

  const loadPages = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const wikiTree = await listDirectory(`${pp}/wiki`)
      const mdFiles = flattenMdFiles(wikiTree)
      const infos: WikiPageInfo[] = []
      for (const f of mdFiles) {
        if (isProductCatalogPath(f.path)) continue
        if (f.name === "index.md" || f.name === "log.md") continue
        if (!shouldRead(f.path)) { infos.push(parseInfo(f.path, f.name, "")); continue }
        try { infos.push(parseInfo(f.path, f.name, await readFile(f.path))) }
        catch { infos.push({ path: f.path, title: f.name.replace(".md",""), type:"other", domain:"general", tags:[] }) }
      }
      const pcInfos = mdFiles.filter(f => isProductCatalogPath(f.path)).map(f => parseInfo(f.path, f.name, ""))
      setProductCatalogPages(pcInfos)
      setPages([...infos, ...pcInfos])
    } catch { setPages([]) }
  }, [project])

  useEffect(() => { loadPages() }, [loadPages, fileTree, dataVersion])

  useEffect(() => {
    if (!project) return
    const tick = () => {
      const summary = getQueueSummary()
      const active = summary.pending + summary.processing > 0
      if (active || queueWasActiveRef.current) {
        void loadProductCatalogPages()
      }
      queueWasActiveRef.current = active
    }
    tick()
    const timer = window.setInterval(tick, 2500)
    return () => window.clearInterval(timer)
  }, [project, loadProductCatalogPages])

  const toggleCheck = useCallback((path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCheckedPaths(prev => { const n = new Set(prev); n.has(path)?n.delete(path):n.add(path); return n })
  }, [])

  const handleBulkDelete = useCallback(async () => {
    if (!project || checkedPaths.size === 0) return
    setIsDeleting(true)
    const pp = normalizePath(project.path)
    const { cascadeDeleteWikiPage } = await import("@/lib/wiki-page-delete")
    for (const path of checkedPaths) { try { await cascadeDeleteWikiPage(pp, path) } catch {} }
    setFileTree(await listDirectory(pp)); bumpDataVersion()
    if (checkedPaths.has(selectedFile ?? "")) setSelectedFile(null)
    setCheckedPaths(new Set()); setShowBulkConfirm(false); setIsDeleting(false)
  }, [project, checkedPaths, selectedFile, setFileTree, bumpDataVersion, setSelectedFile])

  if (!project) return <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">No project open</div>

  const normalizedSearch = normalizeSearch(searchQuery)
  const searchActive = normalizedSearch.length > 0
  const visiblePages = pages.filter(page => pageMatchesSearch(page, normalizedSearch))
  const visibleProductCatalogPages = productCatalogPages.filter(page => pageMatchesSearch(page, normalizedSearch))

  // Type mode grouping
  const typeGrouped = new Map<string, WikiPageInfo[]>()
  for (const p of visiblePages) { const l = typeGrouped.get(p.type)??[]; l.push(p); typeGrouped.set(p.type, l) }
  const sortedTypes = [...typeGrouped.entries()].sort((a,b)=>(TYPE_CONFIG[a[0]]?.order??99)-(TYPE_CONFIG[b[0]]?.order??99))

  // Service mode: entity map keyed by "line:version"
  const entityMap = new Map<string, WikiPageInfo[]>()
  const otherPages: WikiPageInfo[] = []
  for (const p of visiblePages) {
    const h = detectHierarchy(p)
    if (h) { const k=`${h.lineName}:${h.versionName}`; const l=entityMap.get(k)??[]; l.push(p); entityMap.set(k,l) }
    else otherPages.push(p)
  }

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) =>
    set(prev => { const n=new Set(prev); n.has(key)?n.delete(key):n.add(key); return n })

  const checkedCount = checkedPaths.size

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">{project.name}</div>

          <div className="mb-2 grid grid-cols-3 gap-1 px-1">
            <button onClick={()=>setGroupMode("type")} className={`rounded-md px-2 py-1 text-xs ${groupMode==="type"?"bg-accent text-accent-foreground":"text-muted-foreground hover:bg-accent/50"}`}>类型</button>
            <button onClick={()=>setGroupMode("service")} className={`rounded-md px-2 py-1 text-xs ${groupMode==="service"?"bg-accent text-accent-foreground":"text-muted-foreground hover:bg-accent/50"}`}>服务线</button>
            <button onClick={()=>setGroupMode("product")} className={`rounded-md px-2 py-1 text-xs ${groupMode==="product"?"bg-accent text-accent-foreground":"text-muted-foreground hover:bg-accent/50"}`}>产品库</button>
          </div>

          {checkedCount > 0 && (
            <div className="mb-2 flex items-center justify-between rounded-md bg-red-50 border border-red-200 px-2 py-1.5">
              <span className="text-xs text-red-600 font-medium">已选 {checkedCount} 项</span>
              <div className="flex gap-1">
                <button onClick={()=>setCheckedPaths(new Set())} className="text-xs text-muted-foreground px-1.5 py-0.5 rounded">取消</button>
                <button onClick={()=>setShowBulkConfirm(true)} className="text-xs text-white bg-red-500 hover:bg-red-600 px-2 py-0.5 rounded font-medium">删除所选</button>
              </div>
            </div>
          )}

          {/* ── TYPE mode ── */}
          {groupMode === "type" && sortedTypes.map(([type, items]) => {
            const cfg = TYPE_CONFIG[type] ?? DEFAULT_CONFIG
            const expanded = searchActive || expandedTypes.has(type)
            return (
              <div key={type} className="mb-1">
                <button onClick={()=>toggle(setExpandedTypes,type)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
                  {expanded?<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>:<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>}
                  <cfg.icon className={`h-3.5 w-3.5 shrink-0 ${cfg.color}`}/>
                  <span className="flex-1 text-left font-medium">{cfg.label}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </button>
                {expanded && <div className="ml-3">{items.map(p=><PageRow key={p.path} page={p} selectedFile={selectedFile} checkedPaths={checkedPaths} setSelectedFile={setSelectedFile} toggleCheck={toggleCheck}/>)}</div>}
              </div>
            )
          })}

          {/* ── SERVICE LINE mode — tree from SERVICE_HIERARCHY schema ── */}
          {groupMode === "service" && SERVICE_HIERARCHY.map(series => {
            const serExpanded = searchActive || expandedSeries.has(series.seriesName)
            const serCount = series.scenarios.flatMap(sc=>sc.lines.flatMap(ln=>ln.versions.map(vn=>entityMap.get(`${ln.lineName}:${vn.versionName}`)?.length??0))).reduce((a,b)=>a+b,0)
            if (searchActive && serCount === 0) return null
            return (
              <div key={series.seriesName} className="mb-1">
                <button onClick={()=>toggle(setExpandedSeries,series.seriesName)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent/50">
                  {serExpanded?<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>:<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>}
                  <Network className="h-3.5 w-3.5 shrink-0 text-indigo-500"/>
                  <span className="flex-1 text-left">{series.seriesName}</span>
                  {serCount>0&&<span className="text-xs text-indigo-400">{serCount}</span>}
                </button>

                {serExpanded && series.scenarios.map(sc => {
                  const scKey = `${series.seriesName}:${sc.scenarioName}`
                  const scExpanded = searchActive || expandedScenarios.has(scKey)
                  const scCount = sc.lines.flatMap(ln=>ln.versions.map(vn=>entityMap.get(`${ln.lineName}:${vn.versionName}`)?.length??0)).reduce((a,b)=>a+b,0)
                  if (searchActive && scCount === 0) return null
                  return (
                    <div key={scKey} className="ml-3 mb-0.5">
                      <button onClick={()=>toggle(setExpandedScenarios,scKey)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent/50">
                        {scExpanded?<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground"/>:<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground"/>}
                        <ShieldCheck className="h-3 w-3 shrink-0 text-teal-500"/>
                        <span className="flex-1 text-left font-medium text-sm">{sc.scenarioName}</span>
                        <span className="text-xs text-muted-foreground">{sc.lines.length}条服务线{scCount>0?` · ${scCount}项`:""}</span>
                      </button>

                      {scExpanded && sc.lines.map(ln => {
                        const lnKey = `${scKey}:${ln.lineName}`
                        const lnExpanded = searchActive || expandedLines.has(lnKey)
                        const lnCount = ln.versions.map(vn=>entityMap.get(`${ln.lineName}:${vn.versionName}`)?.length??0).reduce((a,b)=>a+b,0)
                        if (searchActive && lnCount === 0) return null
                        return (
                          <div key={lnKey} className="ml-3 mb-0.5">
                            <button onClick={()=>toggle(setExpandedLines,lnKey)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent/50">
                              {lnExpanded?<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground"/>:<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground"/>}
                              <FolderOpen className="h-3 w-3 shrink-0 text-amber-500"/>
                              <span className="flex-1 text-left font-medium">{ln.lineName}</span>
                              <span className="text-xs text-muted-foreground">{ln.versions.length}版{lnCount>0?` · ${lnCount}`:""}</span>
                            </button>

                            {lnExpanded && ln.versions.map(vn => {
                              const vnKey = `${ln.lineName}:${vn.versionName}`
                              const items = entityMap.get(vnKey) ?? []
                              const vnExpanded = searchActive || expandedVersions.has(vnKey)
                              if (searchActive && items.length === 0) return null
                              return (
                                <div key={vnKey} className="ml-3 mb-0.5">
                                  <button onClick={()=>toggle(setExpandedVersions,vnKey)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-accent/50">
                                    {vnExpanded?<ChevronDown className="h-2.5 w-2.5 shrink-0 text-muted-foreground"/>:<ChevronRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground"/>}
                                    <BriefcaseBusiness className={`h-2.5 w-2.5 shrink-0 ${items.length>0?"text-emerald-500":"text-muted-foreground/40"}`}/>
                                    <span className={`flex-1 text-left ${items.length>0?"text-foreground font-medium":"text-muted-foreground/60"}`}>{vn.versionName}</span>
                                    {items.length>0
                                      ? <span className="text-xs bg-blue-100 text-blue-600 rounded px-1">{items.length}</span>
                                      : <span className="text-xs text-muted-foreground/40">未抽取</span>}
                                  </button>
                                  {vnExpanded && items.length>0 && (
                                    <div className="ml-4">
                                      {items.map(p=><PageRow key={p.path} page={p} selectedFile={selectedFile} checkedPaths={checkedPaths} setSelectedFile={setSelectedFile} toggleCheck={toggleCheck}/>)}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )
          })}

          {/* Other non-hierarchy pages (only in service mode) */}
          {groupMode === "service" && otherPages.length > 0 && <OtherSection pages={otherPages} selectedFile={selectedFile} checkedPaths={checkedPaths} setSelectedFile={setSelectedFile} toggleCheck={toggleCheck}/>}

          {/* ── PRODUCT CATALOG mode ── */}
          {groupMode === "product" && (
            <ProductCatalogSection
              pages={visibleProductCatalogPages}
              selectedFile={selectedFile}
              checkedPaths={checkedPaths}
              setSelectedFile={setSelectedFile}
              toggleCheck={toggleCheck}
              expandedProducts={expandedProducts}
              toggleProduct={(key) => toggle(setExpandedProducts, key)}
              forceExpanded={searchActive}
            />
          )}

          {searchActive && visiblePages.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              没有匹配的知识文档
            </div>
          )}

          <RawSourcesSection searchQuery={searchQuery}/>
        </div>
      </ScrollArea>

      {showBulkConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm rounded-lg">
          <div className="bg-background border rounded-xl shadow-xl p-5 mx-4 max-w-xs w-full">
            <div className="flex items-center gap-2 mb-3"><span className="text-xl">🗑️</span><h3 className="font-semibold text-sm">确认批量删除</h3></div>
            <p className="text-xs text-muted-foreground mb-4">将永久删除 <span className="font-bold text-red-500">{checkedCount}</span> 个页面及其向量索引，此操作不可撤销。</p>
            <div className="flex gap-2 justify-end">
              <button onClick={()=>setShowBulkConfirm(false)} className="px-3 py-1.5 text-xs rounded-md border hover:bg-accent">取消</button>
              <button onClick={handleBulkDelete} disabled={isDeleting} className="px-3 py-1.5 text-xs rounded-md bg-red-500 text-white hover:bg-red-600 disabled:opacity-50">
                {isDeleting?`删除中...`:`确认删除 ${checkedCount} 项`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PageRow({ page, selectedFile, checkedPaths, setSelectedFile, toggleCheck }: {
  page: WikiPageInfo; selectedFile: string|null; checkedPaths: Set<string>
  setSelectedFile:(p:string)=>void; toggleCheck:(p:string,e:React.MouseEvent)=>void
}) {
  const isSel = selectedFile===page.path, isChk = checkedPaths.has(page.path)
  return (
    <div className={`group flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-sm ${isChk?"bg-red-50 text-red-700":isSel?"bg-accent text-accent-foreground":"text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"}`}>
      <button onClick={e=>toggleCheck(page.path,e)} className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-opacity ${isChk?"opacity-100 border-red-400 bg-red-100":"opacity-0 group-hover:opacity-100 border-muted-foreground/40"}`} title="选中删除">
        {isChk&&<span className="text-red-500" style={{fontSize:8,lineHeight:1}}>✓</span>}
      </button>
      <button onClick={()=>setSelectedFile(page.path)} className="flex-1 flex items-center gap-1 truncate min-w-0" title={`${page.title}\n${page.path}`}>
        {page.origin==="web-clip"&&<Globe className="h-3 w-3 shrink-0 text-blue-400"/>}
        <span className="truncate">{page.title}</span>
      </button>
    </div>
  )
}

function OtherSection({ pages, selectedFile, checkedPaths, setSelectedFile, toggleCheck }: {
  pages:WikiPageInfo[]; selectedFile:string|null; checkedPaths:Set<string>
  setSelectedFile:(p:string)=>void; toggleCheck:(p:string,e:React.MouseEvent)=>void
}) {
  const [exp, setExp] = useState(false)
  return (
    <div className="mt-1 border-t pt-1">
      <button onClick={()=>setExp(!exp)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
        {exp?<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>:<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>}
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
        <span className="flex-1 text-left font-medium text-muted-foreground">其他知识</span>
        <span className="text-xs text-muted-foreground">{pages.length}</span>
      </button>
      {exp && <div className="ml-3">{pages.map(p=><PageRow key={p.path} page={p} selectedFile={selectedFile} checkedPaths={checkedPaths} setSelectedFile={setSelectedFile} toggleCheck={toggleCheck}/>)}</div>}
    </div>
  )
}

function RawSourcesSection({ searchQuery = "" }: { searchQuery?: string }) {
  const project = useWikiStore(s=>s.project)
  const setSelectedFile = useWikiStore(s=>s.setSelectedFile)
  const selectedFile = useWikiStore(s=>s.selectedFile)
  const [exp, setExp] = useState(false)
  const [sources, setSources] = useState<FileNode[]>([])
  useEffect(()=>{
    if(!project) return
    listDirectory(`${normalizePath(project.path)}/raw/sources`).then(t=>setSources(flattenAllFiles(t))).catch(()=>setSources([]))
  },[project])
  const normalizedSearch = normalizeSearch(searchQuery)
  const visibleSources = sources.filter(source =>
    !normalizedSearch || [source.name, source.path].some(value => value.toLowerCase().includes(normalizedSearch))
  )
  if(visibleSources.length===0) return null
  const isExpanded = !!normalizedSearch || exp
  return (
    <div className="mt-2 border-t pt-2">
      <button onClick={()=>setExp(!exp)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
        {isExpanded?<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>:<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600"/>
        <span className="flex-1 text-left font-medium text-muted-foreground">Raw Sources</span>
        <span className="text-xs text-muted-foreground">{visibleSources.length}</span>
      </button>
      {isExpanded && <div className="ml-3">{visibleSources.map(f=>(
        <button key={f.path} onClick={()=>setSelectedFile(f.path)} className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${selectedFile===f.path?"bg-accent text-accent-foreground":"text-muted-foreground hover:bg-accent/50"}`}>
          <span className="truncate">{f.name}</span>
        </button>
      ))}</div>}
    </div>
  )
}

function shouldRead(path:string):boolean {
  const n=normalizePath(path)
  return !n.includes("/wiki/sources/")&&!n.includes("/wiki/audits/")&&!n.includes("/wiki/media/")
}

function isProductCatalogPath(path:string):boolean {
  return normalizePath(path).includes("/wiki/product_catalog/")
}

function parseInfo(path:string,fileName:string,content:string):WikiPageInfo {
  let type="other",title=fileName.replace(".md",""),domain="general"
  const tags:string[]=[];let origin:string|undefined,lineName:string|undefined,versionName:string|undefined
  const n=normalizePath(path)
  const fm=content.match(/^---\n([\s\S]*?)\n---/)
  if(fm){
    const f=fm[1]
    const tm=f.match(/^type:\s*(.+)$/m); if(tm)type=tm[1].trim().toLowerCase()
    const ttm=f.match(/^title:\s*["']?(.+?)["']?\s*$/m); if(ttm)title=ttm[1].trim()
    const dm=f.match(/^knowledge_domain:\s*["']?(.+?)["']?\s*$/m)??f.match(/^domain:\s*["']?(.+?)["']?\s*$/m); if(dm)domain=dm[1].trim().toLowerCase()
    const om=f.match(/^origin:\s*(.+)$/m); if(om)origin=om[1].trim()
    const lm=f.match(/^line_name:\s*["']?(.+?)["']?\s*$/m); if(lm)lineName=lm[1].trim()
    const vm=f.match(/^version_name:\s*["']?(.+?)["']?\s*$/m); if(vm)versionName=vm[1].trim()
    const tg=f.match(/^tags:\s*\[(.+?)\]/m); if(tg)tags.push(...tg[1].split(",").map(t=>t.trim().replace(/['"]/g,"")))
  }
  if(!fm||title===fileName.replace(".md","")){ const hm=content.match(/^#\s+(.+)$/m); if(hm)title=hm[1].trim() }
  if(n.includes("/wiki/entities/"))type="entity"
  else if(n.includes("/wiki/product_catalog/")){ type="entity"; domain="product_catalog" }
  else if(n.includes("/wiki/concepts/"))type="concept"
  else if(n.includes("/wiki/sources/"))type="source"
  else if(n.includes("/wiki/queries/"))type="query"
  else if(n.includes("/wiki/synthesis/"))type="synthesis"
  else if(fileName==="overview.md")type="overview"
  // Also extract from attributes JSON: line_name / version_name
  if((!lineName||!versionName)&&content.includes("line_name")){
    const am=content.match(/"line_name"\s*:\s*"([^"]+)"/)
    const bm=content.match(/"version_name"\s*:\s*"([^"]+)"/)
    if(am&&!lineName)lineName=am[1]
    if(bm&&!versionName)versionName=bm[1]
  }
  return {path,title,type,domain,tags,origin,lineName,versionName}
}

function flattenMdFiles(nodes:FileNode[]):FileNode[]{
  const f:FileNode[]=[]
  for(const n of nodes){if(n.is_dir&&n.children)f.push(...flattenMdFiles(n.children));else if(!n.is_dir&&n.name.endsWith(".md"))f.push(n)}
  return f
}
function flattenAllFiles(nodes:FileNode[]):FileNode[]{
  const f:FileNode[]=[]
  for(const n of nodes){if(n.is_dir&&n.children)f.push(...flattenAllFiles(n.children));else if(!n.is_dir)f.push(n)}
  return f
}

// ─── Product Catalog Section ─────────────────────────────────────────────────
// Displays wiki/product_catalog/ files grouped by insurance category and product.
// File naming follows scheme A: {category}-{product}-{module}.md
// Parsing: split on first and second "-" segment.

function parseProductCatalogTitle(fileName: string): { category: string; product: string; module: string } | null {
  const base = fileName.replace(/\.md$/i, "")
  // Find the insurance category prefix
  const categories = INSURANCE_CATEGORIES as readonly string[]
  for (const cat of categories) {
    if (base.startsWith(cat + "-")) {
      const rest = base.slice(cat.length + 1)
      const dashIdx = rest.indexOf("-")
      if (dashIdx === -1) return { category: cat, product: rest, module: "" }
      return { category: cat, product: rest.slice(0, dashIdx), module: rest.slice(dashIdx + 1) }
    }
  }
  return null
}

function ProductCatalogSection({ pages, selectedFile, checkedPaths, setSelectedFile, toggleCheck, expandedProducts, toggleProduct, forceExpanded = false }: {
  pages: WikiPageInfo[]
  selectedFile: string | null
  checkedPaths: Set<string>
  setSelectedFile: (p: string) => void
  toggleCheck: (p: string, e: React.MouseEvent) => void
  expandedProducts: Set<string>
  toggleProduct: (key: string) => void
  forceExpanded?: boolean
}) {
  if (pages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center text-xs text-muted-foreground/60">
        <Package className="h-8 w-8 mb-2 text-muted-foreground/30" />
        <p>尚无产品知识库文件</p>
        <p className="mt-0.5">上传产品文档后自动抽取到 wiki/product_catalog/</p>
      </div>
    )
  }

  // Group by category → product
  const grouped = new Map<string, Map<string, WikiPageInfo[]>>()
  const unknown: WikiPageInfo[] = []
  for (const page of pages) {
    const parsed = parseProductCatalogTitle(page.path.split("/").pop() ?? "")
    if (!parsed) { unknown.push(page); continue }
    if (!grouped.has(parsed.category)) grouped.set(parsed.category, new Map())
    const catMap = grouped.get(parsed.category)!
    if (!catMap.has(parsed.product)) catMap.set(parsed.product, [])
    catMap.get(parsed.product)!.push(page)
  }

  return (
    <div className="space-y-1">
      {INSURANCE_CATEGORIES.filter(cat => grouped.has(cat)).map(cat => {
        const products = grouped.get(cat)!
        const catKey = `cat-${cat}`
        const catExpanded = forceExpanded || expandedProducts.has(catKey)
        const totalCount = [...products.values()].reduce((s, a) => s + a.length, 0)
        return (
          <div key={cat} className="mb-1">
            {/* Category header */}
            <button
              onClick={() => toggleProduct(catKey)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent/50"
            >
              {catExpanded
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-blue-500" />
              <span className="flex-1 text-left">{cat}</span>
              <span className="text-xs text-blue-400">{products.size}产品 · {totalCount}页</span>
            </button>

            {catExpanded && [...products.entries()].map(([product, modulePages]) => {
              const productKey = `product-${cat}-${product}`
              const productExpanded = forceExpanded || expandedProducts.has(productKey)
              return (
                <div key={productKey} className="ml-3 mb-0.5">
                  {/* Product header */}
                  <button
                    onClick={() => toggleProduct(productKey)}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent/50"
                  >
                    {productExpanded
                      ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    <FolderOpen className="h-3 w-3 shrink-0 text-amber-500" />
                    <span className="flex-1 text-left font-medium text-sm truncate">{product}</span>
                    <span className={`text-xs rounded px-1 ${
                      modulePages.length >= 5 ? "bg-green-100 text-green-600" :
                      modulePages.length >= 2 ? "bg-blue-100 text-blue-600" :
                      "bg-muted text-muted-foreground"
                    }`}>{modulePages.length}页</span>
                  </button>

                  {productExpanded && (
                    <div className="ml-4">
                      {modulePages.map(p => (
                        <PageRow
                          key={p.path}
                          page={p}
                          selectedFile={selectedFile}
                          checkedPaths={checkedPaths}
                          setSelectedFile={setSelectedFile}
                          toggleCheck={toggleCheck}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}

      {unknown.length > 0 && (
        <div className="mt-1 border-t pt-1">
          <div className="px-2 py-1 text-[11px] text-muted-foreground/60">其他产品文件 ({unknown.length})</div>
          {unknown.map(p => <PageRow key={p.path} page={p} selectedFile={selectedFile} checkedPaths={checkedPaths} setSelectedFile={setSelectedFile} toggleCheck={toggleCheck} />)}
        </div>
      )}
    </div>
  )
}
