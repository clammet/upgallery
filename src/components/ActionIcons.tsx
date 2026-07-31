import { FolderInput, ListChecks, Trash2 } from "lucide-react";

export function SelectListIcon() {
  return <ListChecks aria-hidden="true" size={18} strokeWidth={1.8} />;
}

export function TrashIcon() {
  return <Trash2 aria-hidden="true" size={18} strokeWidth={1.8} />;
}

export function MoveIcon() {
  return <FolderInput aria-hidden="true" size={18} strokeWidth={1.8} />;
}
