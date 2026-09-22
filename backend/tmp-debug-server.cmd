@echo off
set PORT=8788
set STORY_DEBUG_MODEL_OUTPUT=true
start "story-debug" /b node dist/server.js > tmp-direction-debug.stdout.txt 2> tmp-direction-debug.stderr.txt
