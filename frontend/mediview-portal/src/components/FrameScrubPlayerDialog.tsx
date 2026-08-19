import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CaseStreamPlayer, type CaseStreamPlayerProps } from './CaseStreamPlayer';

interface FrameScrubPlayerDialogProps extends CaseStreamPlayerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
}

export function FrameScrubPlayerDialog({
  open,
  onOpenChange,
  title,
  ...playerProps
}: FrameScrubPlayerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[96vh] max-w-[min(1400px,98vw)] overflow-hidden p-0 bg-zinc-950 border-zinc-800">
        <DialogHeader className="border-b border-zinc-800 px-4 py-3 pr-12">
          <DialogTitle className="truncate text-white preserve-case">{title}</DialogTitle>
          <DialogDescription className="text-zinc-500 text-xs">
            Space · J/K/L · ←/→ 5 s · , / . frame step · F fullscreen · M mute · 0–9 seek
          </DialogDescription>
        </DialogHeader>
        <CaseStreamPlayer {...playerProps} />
      </DialogContent>
    </Dialog>
  );
}
