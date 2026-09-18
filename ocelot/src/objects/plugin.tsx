import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import reactFlowCss from '@xyflow/react/dist/style.css';
import { injectCss } from '../lib/styleInject';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { ObjectsList } from './ObjectsList';
import { ObjectDetail } from './ObjectDetail';
import type { DeclaredType } from '../promenade';
import type { Screen } from './types';

injectCss(reactFlowCss);
injectCss(baseCss);

function App({ objectTypes }: { objectTypes: DeclaredType[] }) {
  useHostTheme();
  const [screen, setScreen] = useState<Screen>({ mode: 'list' });

  useEffect(() => {
    // Cross-view navigation's landing spot: a click on an "Object
    // Relationships" chip elsewhere (the Events view, say) asks the host to
    // open this view via `promenade.openView(artifactId, viewId, {
    // focusObjectId, focusObjectType })` — delivered here the same way any
    // other param change is, since this view has no other use for its own
    // params. Fires again for a *second* click while this same panel is
    // already open (the host redirects an already-open cross-view target
    // instead of just focusing stale content), so this is not a one-shot
    // "initial params" read.
    promenade.on('params', (params: any) => {
      if (params?.focusObjectId && params?.focusObjectType) {
        setScreen({ mode: 'detail', objectType: params.focusObjectType, objectId: params.focusObjectId, tab: 'overview' });
        promenade.select([{ kind: 'object', id: params.focusObjectId }]);
      }
    });
    promenade.ready();
  }, []);

  const openDetail = (objectType: string, objectId: string, tab: 'overview' | 'relations') => {
    setScreen({ mode: 'detail', objectType, objectId, tab });
    promenade.select([{ kind: 'object', id: objectId }]);
  };

  if (screen.mode === 'detail') {
    return (
      <ObjectDetail
        objectType={screen.objectType}
        objectId={screen.objectId}
        tab={screen.tab}
        objectTypes={objectTypes}
        onChangeTab={(tab) => setScreen({ ...screen, tab })}
        onBack={() => setScreen({ mode: 'list' })}
        onNavigate={openDetail}
      />
    );
  }
  return <ObjectsList objectTypes={objectTypes} onOpenDetail={openDetail} />;
}

const artifact = promenade.artifact();
const objectTypes = artifact.semantics?.objectTypes ?? [];
createRoot(document.getElementById('root')!).render(<App objectTypes={objectTypes} />);
