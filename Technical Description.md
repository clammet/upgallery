upgallery. The overall goal of this project is to have a space where files/images are listed dynamically.

Technologies used: pnpm, Typescript, Convex, and Docker deployment for the web and storage services. The local `pnpm dev` workflow starts the Convex local development deployment, while Docker/Compose consumes an externally provisioned Convex deployment and does not create or manage Convex containers. You will also need to document how to architecture the docker file system mounts for user-based storage. No tailwind. CSS should be modularized with the goal to be overridden by galleries/uploader settings.

The project involves the concept of a gallery. Which may be one of a few kinds:
* Primarily image gallery - this is a gallery view of images and folders. It has a primary owner, and only that user (and users that user permits) can upload to it. It can be one of two different backend kinds
    * Shared storage - where the resting location of images is in a shared location between all the other galleries of this kind. Each gallery will have it's own top level dir, with subdirs based upon partial hash for even file distribution between file system nodes.
    * User-based storage - where the resting and reading location of images is a location in a user's home folder somewhere, and is expected to be accessed via scp to transfer images to and from. (How to configure these docker layouts/mounts needs to be taken into consideration and documented)
* Uploader (/up/) - This is a kind of gallery view that is normally used to house various file types, and is generally allowed to be uploaded to by anonymous users (however can be configured to only allow (any) SSO users or specific SSO users). It also generally displays more metadata about the entry (e.g. views/downloads, a metadata icon that opens a tabular metadata and location modal), and other features. The backend resting place for these files is a similar layout to the "shared storage" previously mentioned. Each /up/ has it's own parent folder and all the files within (uploaded to) are distributed evenly in subdirs via partial hash of the file.

The project needs to comprise of 2 main interface components: admin interface, user interface
1. Admin interface. This interface needs to be able to do the following:
    * User and permission management (Permissions for system and galleries)
        * Admin permission role for the system - Can do everything. A default admin needs to be specified via ENV flag.
        * Owner of gallery/uploader - Can have multiple. Can manage everything about that gallery/uploader (including deleting it).
        * Editor of gallery/uploader - Can upload/edit everything in the gallery. (This role can be applied to folder(s) of a gallery for a specific user(s). That user will be able to upload/edit everything in that and sub-folders)
        * Viewer of gallery/uploader - Can only view items in the gallery. (This role can be applied to folder(s) of a gallery for a specific user(s). That user will be able to see "unlisted" sub-folders for which they have been applied to)
    * Be able to create new galleries, and manage their settings and permissions.
    * Perform management/migration actions (converting from backend store locations, and other setup tasks)
    * View overall information about galleries (size/number of items, etc.)
2. User interface. This is the primary user interface and is the public facing interface. This has different forms depending on user options and the kind of gallery.
    * The layout should be very minimal with minimal spacing.
    * There should be small logout/login button in the top right, gallery name in the top left with breadcrumb (if applicable) in the middle.
    * Very minimal footer that just says "upgallery"
    * For Uploader galleries:
        * The interface should have a file browser input, and a description box. dragging a file and dropping it anywhere on the page should populate the "file browser input" with that file ready for submission.
        * There should be a password field, that if entered requires password to download/view/edit the file/entry.
        * A user should have an anonymous "cookie-based" account on first viewing that lets them edit/view anything they have uploaded prior. If they log in, the anonymous cookie-based account should be merged into the logged in account, and the logged in account gets access to all the items the anonymous account uploaded.
        * Clipboard pasting anywhere that isn't the description box should initiate a partial upload - it should replace the "file input" field with a preview of the clipboard contents. If it's image based clipboard contents, a thumbnail. If it's text based content, then a small text field should show with partial contents.
        * There is a submit button. Only once that is pressed should data be sent to the server and processed/stored appropriately.
    * For image galleries:
        * The main content should show thumbnails of the images/videos in that "folder"
        * There should be a upload icon and a new folder icon in the top right next to the login/profile button.
        * If the user is signed in and has upload access, clipboard pasting should immediately initiate a upload into the current folder. Only image-based data should be processed on paste. Text based clipboard data pastes should be ignored.
        * Drag and drop anywhere on the page should be treated as an immediate file upload into the current folder.
        * All file types should be allowed, however there should be a file-size limit which is configurable in the admin panel for that gallery. (default config'd via CONST in code.)
        * A folder should be able to be configured, there should be a little cog next to the upload/new folder buttons to edit the current folder's settings (if root folder manages the settings/permissions for the current gallery). Settings should include: folder name, privacy (public, unlisted, private). Unlisted doesn't show in the file listing unless that user has access to the gallery.

Machinery/interplay. Here are some notes about how the various parts of the system need to be handles/interact with each other:
* Image/video formats need to be served a thumbnail in the gallery view
* There should be an extension-mapper to custom thumbnails to display for other file types in the admin interface, with hardcoded defaults.
* The storage/resting place for files in galleries  should act as a direct nginx file serve location. As in, direct URL access should not be processed by any application server. On the other hand, "uploader" based files should only be able to be served via application so that download/view counts can be tracked.
* Login is handled by the `@clammet/convex-googly-auth` component, including anonymous cookie identities, Google SSO, secure session refresh, and identity merging.
* A single docker instance of this app will manage multiple galleries/uploader locations that may span various domains. So the admin interface when setting up a new gallery/uploader will need to prompt the admin for the domain(s) the uploader/gallery will serve for, and the root path.
