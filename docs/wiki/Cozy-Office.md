# Cozy Office

The office is an event-derived view of the workspace. Agents walk, work, carry letters, rest and react to recorded activity. It makes the team's state easier to follow without replacing task records or permission decisions.

## What you see

The 2.5D Pixi scene contains desks/rooms, an idea bin, a break room, pets, speech bubbles and a clock. Pixel sprites use the same ten shapes and fifteen colors as the agents' workspace identities. Animations include idle, walk, carry, work, sleep, bounce and dizzy states.

Rooms reflect collaboration. Letters in flight represent handoffs. Resting agents can show a reason and wake time. Schedule activity is reflected in office clock/calendar/alarm states. The replay/time slider rebuilds past office state from the event log.

## Controls

- Open an agent's chat or its interaction menu from the office.
- Lift an agent to pause busy work at a safe point; drop it to place/resume it according to the supported interaction.
- Use cosmetic interactions such as cheering, petting or a cookie.
- Pan/zoom, focus a room, and choose how much bubble information appears.
- Use topic-only privacy, calm mode, reduced motion and sound preferences.
- Switch to the accessible list view whenever a canvas is inconvenient.

The office never grants credentials, deletes data or authorizes spending through a cosmetic gesture. Read the approval inbox and task trail for consequential actions.

## Accessibility and languages

The wider workspace supports English, Brazilian Portuguese and Spanish, keyboard navigation, clear loading/error states, responsive layouts and reduced motion. Language and timezone are workspace settings. The office list and canvas read the same event-derived state, so the list remains a useful operational view.

Source: [office reducer](../../packages/shared/src/office.ts), [pixel sprites](../../apps/web/src/office/pixels.ts), [office UI](../../apps/web/src/pages/Office.tsx).
