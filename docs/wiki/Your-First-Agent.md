# Your First Agent

An agent is a persistent teammate with its own identity, model policy, daily model budget and computer. Starting a conversation and authorizing work are separate actions in the interface.

## Create a teammate

In **Agents**, choose hatching for guided setup or quick create when you already know the name. Hatching asks for a goal, look and personality, suggests names and introduces the new agent. The shorter flow creates later agents. Quick create needs only a valid name and assigns an available look.

Names are 2–12 characters. A workspace cannot reuse the same shape/color identity: ten shapes and fifteen colors provide 150 looks. The high-definition portraits are used in the workspace; the office renders matching animated pixel sprites.

Before using real services, configure a working model provider. The default roles use `northbot-smart` for work and `northbot-fast` for planning/verification. Setup is currently through the authenticated API; [Models and API](Models-and-API.md) includes an interactive setup example and a no-cost fake-model option.

## Start with a small, reviewable task

Use **Ask** to discuss an idea. Use **Do it** to create a task. Attach only files the agent should receive. A useful first request is:

> Create a short Markdown checklist for reviewing a product listing. Save it in your workspace and tell me where it is.

Choose a small budget and `ask_first` autonomy. Read any cost confirmation and approval card, then approve only the action you intended. Open the task or computer view to inspect progress and the output. A scripted fake model can verify setup but cannot actually reason through this request; switch to a real/local model for useful work.

## Understand waiting and failure

An agent may wait for an approval, a human login handoff, its budget, a schedule or computer readiness. Read the reason before restarting work. Review the event history and **Operations** if a task fails. Repeatedly retrying cannot fix a missing provider key or a blocked destination.

The workspace kill switch stops further agent actions. For a paired Windows computer, the local hotkeys and companion controls also let its owner take control.

## Build a team gradually

Add a researcher and a writer, put them in a room, and give each a concrete role. Use a letter to hand over a request with a clear expected answer. Save a useful fact in Memory, then review a reusable skill before scheduling it. [Team Collaboration](Team-Collaboration.md), [Memory and Skills](Memory-and-Skills.md) and [Schedules and Routines](Schedules-and-Routines.md) explain those workflows.
