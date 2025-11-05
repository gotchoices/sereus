# Web Site for Sereus Fabric

## Project Description
Sereus Fabric (Sereus.org) is a [Web3](https://en.wikipedia.org/wiki/Web3) environment in which connections (threads) are established between users by common consent and based on some existing level of knowledge or trust.
Unlike traditional www identities, Sereus nodes join small subnets (threads) by invitation/consent of the other parties on the thread.
Identities are shared only among those party to the thread and credentials are shared out of band.
So there is not a need for authorities as one might find in an SSL/CA type environment.

Threads can connect two or more users, depending on their purpose and intent.
Each thread contains a database, accessible by the users who are party to the thread and with access appropriate to their role as defined by the thread creator and/or the group.

## Project Components
Sereus Fabric (Sereus.org) is a programming environment that brings together:
- Conventions
- Protocols
- Software Stack:
  - Quereus: https://github.com/gotchoices/quereus
    SQL query processor
  - Optimystic: https://github.com/gotchoices/Optimystic
    B-Tree's, indexes, block storage
  - Fret: (part of optimystic distribution)
    Distributed Hash table
  - Libp2p: https://libp2p.io/
    Community supported peer to peer communication library
- Bootstrap Launch

## Example Uses
Thread databases can contain arbitrary SQL schemas that can support any number of individual applications.
Some possible examples include:

### Secure Messaging
Current messaging platforms involve some degree of centralization.
Even apps like Signal, Telegram and What's App involve a company or corporate/server presence through which connections must be negotiated.
For example, if user A want to initiate a call to user B, he has to negotiate with the gatekeeper (a Signal server) to establish the connection.

By contrast, a Sereus-based messaging app can negotiate using a service on any available libp2p multiaddress.
So even if both nodes are phones running behind a firewall, as long as they can publish a working multiaddress, their message partners will be able to communicate with them directly.
If cases where a relay (with a public IP number) is required, this can be any node--even one controlled privately.

Furthermore, identities are not publicly available.
Messages can be based solely on established threads which are built by invitation only.
The result is, you get messages only from where you want.
No spam.

These features give a degree of security and privacy not generally available by other topologies.

### Social Media
In the early days of social media, there were two simple concepts:
- My Timeline
  A chronological list of all my posts.
- My Feed
  A chronological list of all the timelines of all those I'm following, merged together.

Over time, social media companies got into the business of curating users' feeds.
Rather than just seeing everything, users began to see what the gatekeepers decided they would see including posts by paying advertisers.
This practice lead to spam, ads, shadow banning and other undesirable practices.

In a Sereus framework, a user can build a social media timeline and publish it to selected followers.
Followers can build their own custom feed by prioritizing posts as they wish.
There is no gatekeeper in the middle.

### Classified / Auction / E-Commerce
In addition to building a private social media timeline, a user (or company) might build a for-sale space.
Clearly, it is not enough to simply list one's goods on an unknown page on the Internet.
The important part is that those who want to buy those items must be able to find them.

Current web topology favors centralization around a few large players.
Shoppers for new goods go to Amazon because they know so many sellers are listing there.
Shoppers for used goods go to Ebay for the same reason.
Other centralized services (like Facebook Marketplace) are making significant inroads.
But there is not really an objective way to search for goods and services on the Internet.
A Google search does not always yield the items you need, but rather the items that are being most aggresively advertized to you.

Sereus Fabric offers a neutral ground where multiple commercial services can operate, selling services such as:
- Publicity: Makes sure that buyers will find your goods, services listed for sale.
- Indexes: Facilitates Searching for what you want/need.
- Shipping: Guarantees that what you buy will actually be delivered
- Escrow: Guarantees that you don't pay unless the good/service is rendered

Sereus contemplates that a seller can use the publisher of his choices and the buyer can use the search of his choices.
In either case, they will find each other.
Services like shipping and escrow can be chosen by reputation and common consent.

### Distributed Storage
One challenge today is how users can store all their photos and other data.
The traditional solution is to pay a monthly fee for cloud storage and backups.

Sereus is all about shared databases.
It is possible users could form threads for the purpose of backing up and sharing data storage.

A user might build a cloud server or a physical linux box with a large hard disk.
This can become part of the user's operational node cluster (cadre).
If two such users form a common database, their data will be sharded across more nodes offering greater resilience to data loss.

### Medical Records
Much has been hoped for in the field of secure medical records.
The primary problem is: Who can you trust to securely keep your medical record.

Under a Sereus topology, the answer is simple: You.

A user could initialize a blank medical record which is simply a shared database with only a single subscriber/keeper.
The patient could simply share a QR code with his doctor and the doctor's cadre would suddenly have appropriate access to the database and would begin storing relevant data across participating devices.
Whent he patent then shares the database with a second provider, access if now available (if granted) to the existing medical record.
Furthermore, data is now sharding across a larger number of nodes providing additional data security.

The patient is always in charge of his own record.
Access can be terminated at any time for any provider, data storage provider, etc.

### Community Voting
There is an ongoing development project at https://votetorrent.org.
This will bring more transparency and security to elections.

### Digital Currency
The [MyCHIPs digital medium of exchange project](https://mychips.org) is historically based on two separate, individual databases kept by two parties to a single logical shared tally of credit entries.
MyCHIPs is being retooled to work on a Sereus thread.
This will eliminate many of the existing challenges of consensus between tally partners.
It will also simplify the application layer greatly as many of the storage issues will be dealt with by the Sereus stack.

