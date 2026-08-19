import { useEffect } from 'react';
import { ExternalLink, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';

const CALL_APP_URL = 'https://call.octelerad.com';

export default function VideoCalls() {
  useEffect(() => {
    window.open(CALL_APP_URL, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border bg-card p-5 text-center shadow-sm">
        <Video className="mx-auto h-8 w-8 text-primary" />
        <h1 className="mt-3 text-xl font-semibold tracking-tight">Video Calls</h1>
        <p className="mt-2 text-sm text-muted-foreground">OCTELERAD Call opens in a separate tab.</p>
        <Button className="mt-4 w-full" asChild>
          <a href={CALL_APP_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-2 h-4 w-4" />
            Open Video Calls
          </a>
        </Button>
      </div>
    </div>
  );
}
