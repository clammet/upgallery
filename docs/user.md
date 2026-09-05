# User guide

Upgallery has two modes: **Gallery** for browsing folders and media, and
**Uploader** for submitting and sharing individual files. The features available
to you depend on the site and your account's permissions. This guide covers
visitors, contributors, and gallery owners. System administration is outside
its scope.

## Features

- [Google login and account preferences](#log-in-and-manage-your-preferences)
- [Gallery browsing](#browse-a-gallery)
- [Image, video, audio, document, and code previews](#view-download-and-share-files)
- [Zoom and keyboard shortcuts](#view-download-and-share-files)
- [File downloads and sharing links](#view-download-and-share-files)
- [File information and location maps](#view-download-and-share-files)
- [Single-file uploads](#submit-a-file-in-the-uploader)
- [Clipboard file, image, and text uploads](#submit-a-file-in-the-uploader)
- [File descriptions, passwords, and unlisted uploads](#submit-a-file-in-the-uploader)
- [Markdown rendering](#manage-your-own-uploads)
- [Multiple-file and folder uploads](#contribute-files-to-a-gallery)
- [Upload progress, retries, and filename conflicts](#contribute-files-to-a-gallery)
- [Gallery owner controls and storage usage](#open-the-owner-controls)
- [Gallery names and upload size limits](#change-the-name-upload-limit-and-appearance)
- [Themes, colors, layout, and custom CSS](#change-the-name-upload-limit-and-appearance)
- [Folder previews and file sorting](#choose-how-an-image-gallery-is-browsed)
- [Infinite scroll and page navigation](#choose-how-an-image-gallery-is-browsed)
- [Friendly folder links](#choose-how-an-image-gallery-is-browsed)
- [Custom file-type thumbnails](#customize-file-type-thumbnails)
- [Viewing and upload permissions](#control-who-can-view-and-contribute)
- [Invitations and owner, editor, and viewer roles](#control-who-can-view-and-contribute)
- [Folder names, access, and visibility](#set-folder-access-and-presentation)
- [Inherited folder permissions](#set-folder-access-and-presentation)
- [File renaming and location data removal](#organize-and-remove-gallery-content)
- [File and folder selection, moving, and deletion](#organize-and-remove-gallery-content)
- [Drag-to-move and editor bulk actions](#organize-and-remove-gallery-content)
- [Directory scans and uploader attribution](#refresh-a-gallery-connected-to-an-existing-directory)
- [Gallery and uploader deletion](#delete-a-gallery-or-uploader)

## Open a gallery or uploader

Use the link provided by the person sharing the site. A site may have its own
domain or path. You may also receive a link in one of these forms:

| Address | What it opens |
| --- | --- |
| `/g/<gallery-name>` | A gallery with folders and file thumbnails. |
| `/up/<uploader-name>` | An uploader with a submission form and file listing. |

These are website paths: replace the name in angle brackets with the name in
your supplied link. `/up` by itself does not identify an uploader.

Click the site name in the header to return to its root page. To return to a
particular gallery folder later, bookmark its address.

## Log in and manage your preferences

Public content may be browsed without logging in. Some sites also allow uploads
without an account. For restricted content or uploads, click **Log in** in the
header and sign in with Google using an account that has been given access.
Logging in alone does not grant access to a restricted gallery or folder.

Once logged in, click your name in the header to open **Account**:

| Feature | What it does |
| --- | --- |
| **Edit display name** (pencil) | Changes the name shown for your account. Enter a name and click the checkmark to save. |
| **Infinite scroll** | Loads more gallery files as you scroll. Turn it off to use **Previous** and **Next** page buttons. This option is unavailable when the gallery has disabled infinite scroll. |
| **Lightbox overzoom** | Allows images in the viewer to be enlarged beyond their original size. |

Click **Log out** in the header to sign out.

## Browse a gallery

Open a gallery link to see its folders and files in a thumbnail grid.

- Click a folder to open it. Use the folder trail in the header to return to a
  parent folder.
- Click a file thumbnail to open the **viewer**, also called the lightbox.
- Scroll down to load more files, or use **Previous** and **Next** below the grid
  when page navigation is enabled.
- Click a file's **View metadata** information icon, when present, to see details
  such as the uploader, image dimensions, camera information, and recorded
  location. Available details vary by file.

Some galleries update their file listings in the background. The header may
show that an update is queued, in progress, or complete.

## View, download, and share files

The viewer is available from gallery thumbnails and from the filename or **View**
area of an uploader entry.

Images, browser-supported video and audio, PDFs, plain text, Markdown, and source
code can be previewed. Video and audio use playback controls. Markdown is shown
as formatted content, and recognized source code has syntax highlighting.
Preview support depends on the file and browser. For unsupported files, use
**Open original** or **Download**.

| Control | Where to find it and what it does |
| --- | --- |
| **Previous / Next** | Viewer navigation arrows; move between available files. |
| **Download** | Viewer toolbar; saves the file. |
| **Open in new tab** | Viewer toolbar; opens the file separately. In the uploader, this uses a temporary address that should not be used as a sharing link. |
| **Copy link** | Link icon beside the filename; copies an address that opens the file in the viewer. In a gallery, **Ctrl-click** or **Cmd-click** copies a direct file link instead. |
| **View at actual size (1:1)** | Viewer toolbar for images and video; switches between actual size and fitting the media to the viewer. |
| **Show information** | Viewer toolbar; opens file details and a location map when location metadata is available. |
| **Close** | Viewer toolbar; returns to the listing. |

Use the mouse wheel over an image or video to zoom, then drag to pan when zoomed
in. On a touch screen, swipe left or right while zoomed out to change files.

The viewer also supports these keyboard shortcuts when you are not typing into
a field:

| Key | Action |
| --- | --- |
| **Left / Right arrow** | Previous / next file. |
| **A** | Toggle actual size for images and video. |
| **Space** | Open the file in a new tab. |
| **Esc** | Close the viewer. |

For password-protected uploader files, enter the file password and choose
**View file** before viewing or downloading. Obtain the password from the person
who shared the file. Sharing a link does not remove access or password requirements.

## Submit a file in the uploader

Open your uploader link, usually `/up/<uploader-name>`. If uploading is available
to you, the submission form appears above the file listing.

1. Click **Choose a file, drop it here, or paste** to select a file, drag a file
   onto the page, or paste a copied file or image.
2. Optionally fill in the settings below.
3. Click **Submit** and keep the page open while it says **Uploading…**.
4. When the upload succeeds, its viewer opens. Use **Copy link** to copy its
   viewer address.

The uploader accepts one file per submission. When dropping or pasting multiple
files, only the first is selected. Folders cannot be uploaded here.

| Setting | What it is for |
| --- | --- |
| **Description** | Adds explanatory text beneath the filename in the listing. |
| **Password** | Requires a password to view or download the file. Leave it blank for no file password. |
| **Unlisted** | Hides the file from other users' listings; it remains visible in yours. This controls listing visibility separately from password protection. |
| **remove location data** | Appears when location data is detected in a selected image. Select it to remove that information from the uploaded image. |

To upload clipboard text, paste onto the page while no input or description
field is focused. The uploader creates a text file and shows a short preview.
Use the **Markdown** switch beside the preview if you want it displayed as
formatted Markdown. This changes the file extension between `.txt` and `.md`.

The listing shows filenames, descriptions, file sizes, and view counts. A lock
icon marks password protection; a crossed-out eye marks your unlisted files.

### Manage your own uploads

The following controls appear when you have permission for the file:

- **Rename:** Open the file in the viewer and click its filename, labelled
  **Edit filename**. Enter the new name and click **Save filename**. Unlock a
  password-protected file first.
- **Markdown:** For eligible text files, use the viewer's **Markdown** switch to
  change between plain text and Markdown. This changes the saved file's extension,
  so it also affects how others see the file.
- **Remove location data:** Open **View metadata** from the listing and use
  **Remove location data** beside the location details, when available. Confirm
  **Remove** to rewrite the stored image permanently; this cannot be undone.
- **Delete file:** Click the trash icon on the listing entry, then confirm
  **Delete**. Enter the file password if prompted. Deletion cannot be undone.

## Contribute files to a gallery

When you have upload permission, the gallery header includes **Upload files**
and **New folder**.

Open the destination folder first, then use one of these methods:

- Click **Upload files** and select one or more files. Uploading starts immediately.
- Drag files or folders onto the page. Folder drops preserve their folder structure
  when supported by your browser.
- Paste copied images onto the page to upload them to the current folder.
- Click **New folder**, enter a **Folder name**, and click **Save** to create a
  folder for your uploads.

For gallery uploads, the transfer status area shows queued, active, finished,
and failed files. Click **Show transfer details** to inspect individual uploads.
Use **Retry** on a failed upload when offered, and **Clear finished transfers**
to remove completed status entries from the panel.

If a filename already exists, choose **Replace** to overwrite it or **Auto
rename** to keep both files under different names. For a batch, **Replace all**,
**Auto rename all**, and **Skip** apply to conflicting items. Keep the page open
until your uploads finish.

## Manage a gallery you own

Gallery owners can organize content and configure their gallery or uploader.
These settings affect everyone using that gallery.

### Open the owner controls

Log in with the Google account that has **Owner** access, then open `/admin` on
the site and choose your gallery from the sidebar. Although the page is labelled
**Administration**, it also contains the settings available to gallery owners.
In an image gallery, you can reach the same page through **Folder settings**
(the gear in the gallery header), then **Gallery admin**.

The owner page shows the number of **Items** and the **Storage** used. Click
**Open** beside the gallery name to return to its public page.

Owner access for the whole gallery, including an owner grant on its root folder,
provides these settings. Ownership of a subfolder provides content controls
within that folder and its descendants, but does not open the gallery-wide
settings page.

### Change the name, upload limit, and appearance

On the owner page, find **Settings**, make your changes, then click
**Save settings**.

| Setting | What it does |
| --- | --- |
| **Name** | Changes the displayed gallery name. It does not change the site's address. |
| **Maximum file size** | Sets the size allowed for each new upload, in MiB. Owners can choose a value up to the limit shown beside the field. |
| **Density** | Chooses compact or comfortable spacing. |
| **Thumbnail frame width** | Sets the width of thumbnail frames, from 96 to 512 pixels. |
| **Appearance** | Chooses a light or dark theme. Changing it resets the color fields to that theme's defaults; choose the mode before customizing colors. |
| **Actions & selection** | Sets the color used for links, active controls, selections, and progress indicators. |
| **Folders & file previews** | Sets the color used for folder artwork and generic file-preview backgrounds. |
| **Page canvas** | Sets the main page background color. |
| **Primary text & icons** | Sets the main text and icon color. |
| **Cards & panels** | Sets the surface color for cards, forms, dialogs, and panels. |
| **Secondary text & icons** | Sets the color of descriptions, metadata, and helper text. |
| **Header divider** | Sets the color of the line below the header. |
| **Gallery cell borders** | Sets the border color of folder and file cards. |
| **Corner radius** | Sets how rounded corners appear, from 0 to 40 pixels. |
| **Scoped custom CSS** | Allows owners familiar with CSS to customize styling beyond the color and layout controls. Scope selectors to the gallery's `[data-gallery="<slug>"]` container, replacing `<slug>` with its internal name. |

Use the color pickers or enter six-digit hex colors, such as `#126b5a`.

### Choose how an image gallery is browsed

These additional controls are in **Settings** for image galleries. Click
**Save settings** after changing them.

| Setting | What it does |
| --- | --- |
| **Folder preview default** | Chooses the artwork on folder cards: **First image**, **Random**, **First 3**, **Random 3**, or **Custom**. The three-image choices show a collage. Individual folders can override this default. |
| **Filename/URL** | Appears for a **Custom** preview. Supply an image filename or URL; filename suggestions are offered while typing when available. |
| **Subfolder previews** | Allows images in nested subfolders to fill folder previews. |
| **Quick move** | Allows users with move permission to drag files and folders into folders without first entering select mode. It does not grant move permission. |
| **Thumbnail order** | Sorts files by filename/title, size, or date taken, in either direction. Individual folders can choose a different order. |
| **Infinite scroll** | Automatically loads more gallery files as visitors scroll. Turning it off uses **Previous** and **Next** page navigation and disables the account-level infinite-scroll switch for this gallery. |
| **Files per page** | Chooses how many files are requested per page or scrolling batch: 50, 100, 150, 200, or 250. |
| **Folder URLs** | Chooses **Internal folder IDs** or **Friendly folder paths** for navigation and copied folder links. Friendly paths use the folder names in the address. |

### Customize file-type thumbnails

Open **File-type thumbnails** on the owner page to choose how files without a
media preview are represented in this gallery.

Enter the extension (for example, `zip`), a **Label**, and a **Text fallback**.
Optionally enter a **thumbnail URL**, then click **Save**. Save the same extension
again to update its override. Click **Restore default** beside an override to
return that extension to its bundled appearance.

### Control who can view and contribute

Open **Permissions** on the owner page. The first two rows control access for
**Anonymous** visitors and **Any logged-in user**. Each row offers:

| Permission | What it allows |
| --- | --- |
| **No access** | Gives that group no default access. A named grant or applicable public-folder policy can still provide access. |
| **Viewer** | Allows browsing and viewing files. |
| **Editor / upload** | Allows viewing and uploading. In image galleries, editors can also create folders, edit folder settings, rename files, and remove image location data. Bulk move and delete require the separate setting described below. |

These dropdowns save immediately. For example, choose **Viewer** for Anonymous
and **Editor / upload** for Any logged-in user to allow public browsing and
uploads from signed-in users. For access by invitation, choose **No access** for
both groups and grant access to named accounts.

To grant access to a person:

1. Enter their Google account address in **User email**.
2. Choose **Viewer**, **Editor**, or **Owner**. A whole-gallery owner can manage
   settings, permissions, content, and deletion of the gallery.
3. Leave **Folder ID** blank for the whole gallery, or enter a folder ID to apply
   the grant to that folder and its descendants. With **Folder URLs** set to
   **Internal folder IDs**, open a non-root folder and copy the `folder` value
   from its address, without the `folder=` prefix.
4. Click **Grant**. Share the gallery or folder link with the person so they can
   sign in. For a new account, the saved invitation takes effect when that email
   first signs in with Google; this action does not send an invitation email.

Submit the same email and scope again to change its role. Use **Revoke** beside
a saved grant to remove it. Revoking a grant does not remove access provided by
another grant or a group permission. The app refuses to revoke the last
whole-gallery owner grant.

When several permissions apply, the strongest applicable role wins. A
folder-specific Viewer grant does not reduce someone's whole-gallery Editor
or Owner access. A grant on a subfolder also does not grant access to its parent
folders; users need access to the gallery itself to open it through the site.

### Set folder access and presentation

In an image gallery, open the folder and click **Folder settings** in the header.
The **New folder** form also offers access and preview choices when creating a
folder. Click **Save** to apply form changes.

| Setting | What it does |
| --- | --- |
| **Folder name** | Renames the current folder. Friendly folder addresses change when folder names change. |
| **Access override: Inherit parent access** | Uses the nearest parent access policy, or the gallery's permissions when no parent overrides it. |
| **Access override: Public — everyone can view** | Allows viewing regardless of the default group role for this folder. Visitors still need to be able to open the gallery itself. |
| **Access override: Restricted — explicit grants only** | Ignores the Anonymous and Any logged-in user defaults. Named grants for the gallery, this folder, or an ancestor still apply. |
| **Discoverability: Listed** | Shows the folder in its parent's listing to users who can view it. |
| **Discoverability: Unlisted — hidden from viewers** | Hides the folder from viewers' listings; editors and owners can still see it. Users with view access can still open its link, so this is separate from restricting access. |
| **Folder preview** | Uses the gallery default or a first-image, random-image, three-image, or custom preview for this folder. **Custom** requires a **Filename/URL**. |
| **Thumbnail order** | Uses the gallery default or overrides file sorting for this folder by name, size, or date taken. |

The root folder's access is controlled through gallery permissions, so it does
not offer the access override or discoverability dropdowns.

To clear access overrides throughout a folder tree, use **Reset this and children
folders to inherit** in **Folder settings**. To reset across the gallery, use
**Reset children folders to inherit** beside **Permissions** on the owner page.
These buttons start the reset immediately, with descendants processed in the
background. They reset access policies only; named grants, discoverability, and
preview settings remain as configured. Previously restricted folders may become
viewable under their inherited permissions.

### Organize and remove gallery content

In an image gallery, owners can use the following controls in addition to
uploading and creating folders:

- **Rename a file:** Open it in the viewer, click its filename (**Edit filename**),
  enter the new name, and click **Save filename**.
- **Remove image location data:** Open **View metadata** from a file card, click
  **Remove location data** when available, and confirm **Remove**. This permanently
  rewrites the stored image.
- **Select files and folders:** Click **Select items** in the gallery header,
  then click the items to select them. **Ctrl+A** or **Cmd+A** selects all files
  in the current folder, including files on pages not yet loaded, plus its listed
  subfolders. Click the select-mode button again to exit.
- **Move a selection:** Click **Move to…**, choose a destination gallery and
  folder, then click **Move here**. Files can move to another image gallery you
  own. A selection containing folders must stay within its current gallery;
  a folder cannot move into itself or one of its descendants.
- **Drag to move:** In select mode, drag selected items onto a folder card or
  an ancestor in the folder trail. With **Quick move** enabled, dragging is also
  available outside select mode.
- **Delete a selection:** Click **Delete selected**, review the selection, and
  confirm **Delete**. Deleting a folder includes its contents. This cannot be undone.

The viewer also has **Move to…** and **Delete** controls for its current file.
Use the transfer panel to follow moves and deletions and resolve filename
conflicts when prompted.

To let editors use selection, move, and delete controls, open **Danger zone** on
the owner page and **Enable** **Editor bulk actions**. This saves immediately
and applies to every editor, including anonymous visitors or all signed-in users
if their group has **Editor / upload** permission. **Disable** removes those
additional powers from editors; owners retain them. It does not give editors
access to gallery-wide owner settings.

For an **uploader**, file-level rename, Markdown, location removal, and deletion
controls remain limited to the person who uploaded the file. Owning the uploader
does not grant those controls over other people's submissions or bypass their
file passwords.

### Refresh a gallery connected to an existing directory

Some image galleries are connected to an existing directory of files. These
galleries offer **Scan folder** in **Folder settings**, and beside **Items** on
the owner page for scanning from the gallery root. Use it to refresh the gallery
after files have been added, changed, or removed outside the website. The icon
shows when the scan is queued or running.

Files discovered in that directory may show **Unknown** as their uploader.
In **Permissions**, **Take Unknown** beside a whole-gallery Owner grant assigns
the gallery's currently unclaimed files to that owner. The transfer runs in the
background and updates their uploader attribution; files already attributed to
someone else keep their existing owner.

### Delete a gallery or uploader

On the owner page, open **Danger zone** and click **Delete gallery**. Confirm the
prompt naming the gallery to remove it and queue all its files for deletion.
This applies to the entire gallery or uploader, including other users' files.
There is no undo control.

## Common problems

| Message or situation | What to do |
| --- | --- |
| **Access restricted** | Log in with the account that was given access. If you are already logged in, contact the person who shared the gallery or folder. |
| **Log in with an allowed account to upload** | Sign in with an account permitted to upload to this site. |
| **Not found**, **Folder not found**, or no gallery configured | Check that you opened the complete link, including its domain and path. Ask the sender for a current link if needed. |
| **Preparing full-resolution preview…** | Wait for the preview to finish processing. Some image formats require preparation before they can be displayed. |
| A file cannot be previewed, or a text file is too large to preview | Use **Download** or **Open original** and open it with an appropriate application. |
| An upload fails | Read the error beside the form or in transfer details. File type, size, and available storage limits can vary by site. Correct the reported problem and submit again, or use **Retry** if available. |
| A temporary uploader file address stops working | Reopen the file from the uploader or its copied viewer link to obtain fresh access. Use **Copy link** for sharing. |
