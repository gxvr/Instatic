import { useState } from 'react'
import type { Page, PageTemplateConfig } from '@core/page-tree'
import { TemplateSettingsDialog, type TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog'

interface UseTemplateSettingsDialogOptions {
  pages: Page[]
  renamePage: (pageId: string, title: string, slug?: string) => void
  convertPageToTemplate: (pageId: string, config: PageTemplateConfig) => void
  openPageInCanvas: (pageId: string) => void
}

/**
 * Owns the "Template settings" dialog state for the site explorer — pulled
 * out of SiteExplorerPanel purely to keep that file under the module-size
 * ceiling; no behavior change.
 */
export function useTemplateSettingsDialog({
  pages,
  renamePage,
  convertPageToTemplate,
  openPageInCanvas,
}: UseTemplateSettingsDialogOptions) {
  const [templateSettingsTarget, setTemplateSettingsTarget] = useState<Page | null>(null)

  function handleSaveTemplateSettings(payload: TemplateSettingsPayload) {
    if (!templateSettingsTarget) return
    renamePage(templateSettingsTarget.id, payload.title, payload.slug)
    convertPageToTemplate(templateSettingsTarget.id, payload.template)
    setTemplateSettingsTarget(null)
    openPageInCanvas(templateSettingsTarget.id)
  }

  const dialog = templateSettingsTarget && (
    <TemplateSettingsDialog
      page={templateSettingsTarget}
      pages={pages}
      onCancel={() => setTemplateSettingsTarget(null)}
      onSave={handleSaveTemplateSettings}
    />
  )

  return {
    openTemplateSettings: setTemplateSettingsTarget,
    dialog,
  }
}
