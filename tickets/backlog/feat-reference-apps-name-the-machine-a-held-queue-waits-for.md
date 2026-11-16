description: The reference chat apps show that a message has not been delivered, but not which of the user's machines it is waiting for or what to do if that machine is gone. Show the machine's name and offer to remove it from the cadre.
prereq: removing-a-machine-releases-an-offline-queue-waiting-for-it
files: packages/reference-app-rn, packages/reference-app-web, docs/platforms/reference-apps.md (Messages not yet delivered)
tradeoffs: The core API already lets any app do this, and the reference apps exist to show usage rather than to be finished products, so it can wait until a real app asks how to present it.
----
# Reference apps name the machine a queue is waiting for

`CadreNode.getUnreachedStrandMachines(strandId)` names the party's machines an offline queue is waiting for, and `CadreNode.removeMachine` releases the wait. The reference apps' offline status line shows only that messages are queued. An app reading `strand:queue-state` with `waitingFor: 'cohort'` should show the machine, using its `listMachines` entry, and link to the existing machine-removal screen, so a user with a dead node has a way out without being told to discard messages.
