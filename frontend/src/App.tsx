import {
  CompletedStory,
  ConflictCorePickerScreen,
  HeadTailScreen,
  OpeningScreen,
  PredicamentPickerScreen,
  StorySpineScreen,
} from './components/StoryScreens'
import { CreativeBriefScreen, ProvisionalCurveScreen } from './components/CoCreationScreens'
import { useStorySession } from './story/useStorySession'

function App() {
  const session = useStorySession()

  switch (session.view) {
    case 'creative-brief':
      return <CreativeBriefScreen session={session} />
    case 'provisional-curve':
      return <ProvisionalCurveScreen session={session} />
    case 'conflict-core-picker':
      return <ConflictCorePickerScreen session={session} />
    case 'predicament':
      return <PredicamentPickerScreen session={session} />
    case 'head-tail':
      return <HeadTailScreen session={session} />
    case 'story-spine':
      return <StorySpineScreen session={session} />
    case 'complete':
      return <CompletedStory session={session} />
    default:
      return <OpeningScreen session={session} />
  }
}

export default App
