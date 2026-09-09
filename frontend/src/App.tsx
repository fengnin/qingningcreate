import {
  CompletedStory,
  DirectionPickerScreen,
  HeadTailScreen,
  OpeningScreen,
  StorySpineScreen,
} from './components/StoryScreens'
import { useStorySession } from './story/useStorySession'

function App() {
  const session = useStorySession()

  switch (session.view) {
    case 'direction-picker':
      return <DirectionPickerScreen session={session} />
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
