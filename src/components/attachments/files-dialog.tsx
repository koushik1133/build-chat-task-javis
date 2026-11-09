"use client";

import { Dialog } from "@/components/ui/dialog";
import { AttachmentPanel } from "./attachment-panel";
import type { AttachmentEntityKind } from "@/lib/attachments/types";

/** Files for one entity in a modal — used from table rows (billing, CRM) where there is no detail drawer. */
export interface FilesTarget {
  kind: AttachmentEntityKind;
  id: string;
  label: string;
}

export function FilesDialog({ target, onClose, canEdit = true, allowPortal = true }: { target: FilesTarget; onClose: () => void; canEdit?: boolean; allowPortal?: boolean }) {
  return (
    <Dialog title={`Files · ${target.label}`} description="Attachments stay private to your team unless marked visible in the client portal." onClose={onClose} size="md">
      <AttachmentPanel entityKind={target.kind} entityId={target.id} canEdit={canEdit} allowPortal={allowPortal} />
    </Dialog>
  );
}
