# ToDo

- Integrate the DE into Vertex Linux and then remake the website and add an interactive version of the DE so users can test it (DO LATER)
- Maybe at some point decrease the ram/cpu usage but for right now it runs fine on any computer with above 8GB of ram (DO LATER)
- Switch the DE to using Wayland instead of X11 (do this over Thanksgiving break when I have time)
- Improve the widets and make them look better and function smoother, and also fix up the widget creator as it looks really broken if the window is too small
- Fix the sound and brightness sliders still looking a bit scuffed and broken.
- Fix multidesktop not working AT ALL, so if the DE is used on any PC with 2 or more monitors the entire DE breaks down and just stops functioning entierly/breaks and lags and more.

# Fixed
- Make it so you can hide the battery icon entierly if your on a PC with no device connected that reports its battery. (Add this as a toggle switch under the top bar menu with the 24 hour clock and show secconds option)
- I can get the entire desktop to crash and restart itself by enlarging a window, and then making it smaller and that makes the entire desktop freeze, go black for a seccond, and then recover, this is SUPER reproducable that I was able to do it several times while just using the DE, If i try to resize any window the entire desktop and freeze and crash (it does recover but the freezing and then after it recovers setting the window to a random size is kinda anoying) (FIX ATTEMPTED: test on the NVIDIA laptop; crashes are now logged to ~/.config/LiquidDesktop/crashes.log)
- The issue where you have to click an app a few times for it to open STILL persists for some reason, I am still having this issue on my nvidia laptop where I ahve to click an app a few times even while its bouncing to get it to open properly (and as before this only happens with internal apps, apps that are installed from the app store or from command open just fine first try) (FIX ATTEMPTED: test on the NVIDIA laptop)
- Make the launcher app checker check the Flatpak /home/(username)/.var/app/com.valveSoftware.Steam/Desktop folder for more .desktop files of steam game files (add a section in settings for the launcher to look for .desktop files in spesific folders the user can add)
- Make it so on the bottom part of the file explorer where it shows your current location (where it says like Computer > Home > Username stuff like that) if you click anywhere that isnt a folder name it will turn into a textbox where you can manualy enter your own path and paths that look like the one your typing in will pop up above the text box as search sugjestions, it will turn back into the UI after you press enter
- Add google or duck duck go or somthing else (customisable in setings) search sugjestions in the browser, so while searching sugjestions will appear below the search bar
- Add a selector very simmalar to the one on the desktop into the file manager where it would be WAY more usfull to select multiple files at onece to do bulk actions
- On a larger screen (Like on my 1440P 16:10 Laptop screen I) I cant make android app windows large enough, so make the max window size relitive to the screen size, as right now the max window size is WAY too small, like theres over 400 pixles left on each side bewteem the dock and top bar I can resize it larger but i can (I can make it smaller but not larger than that last mesurment I gave)
- Make it so in the wallpapers menu intead of choosing one image from files to use you can choose multiple images to upload into the library and then you can select from there instead of having to look through your files each time to upload a wallpaper
- Implement android compatibility with a waydorid installer in settings to allow android apps to run inside of the OS, it will run Waydroid in the windowing mode and make it easy to install it by fetching all of the needed things and running the installer and stuff automaticly and eveyrthing through settings (in its own waydroid section), and like I said before it will run in windowing mode so all the Android winodws can be in their own window, and try to see if you can make them have the MacOS Window borders instead of the android ones to make it more immersive, make it easy to disable or force quit or uninstall waydroid if the user isnt happy, and make gapps enabled by defualt and add a section for making your device play certified. (Note: Android runs in ONE LiquidDesktop-framed window; one window per Android app needs a Wayland session)
- Fix the system monitor reporting that several tasks are using 20% CPU usage when the overall CPU usage is 5% (confirmed by the widget and btop, the system monitor is not reporting app usage correctly)
- Fix the top bar not having any blur and just being slightly opaque (There are more blur issues like this all over the desktop where some elements are just slightly opaque instead of being blurred properly for some reason)
- The now playing widget seems to not work, this may be an issue with the Nested instance or the code might actualy be broken
- If i just move my mouse around the screen the size just randomly changes, like on the left and right sides of the screen if i move it all the way to the left or right the cursor just changes sizes, and going into windows timetimes changes the cursor size too
- The bluetooth menu does not show a way to connect to/ pair exsiting or new devices, it just has a toggle to enable/disable bluetooth
- Make the sound menu (in settings) display input and output deivces, their volume (especily for input devices) and a way to choose between them, and then in the control center like in MacOS make the sound menu able to drop down to show audio devices that you can choose from
- Add proper OSD for Brightness and Audio (and make the brightness and volume keys that are on some keyboards actualy work, as I dont think that functionality has been added yet to the DE, idrk i didnt test it), make it look like the MacOS one (not the old pre big sur one the new one thats like the one on iPhone)
- When I tried to move a folder that I created on the desktop to trash, it duplicated all the icons on the desktop for some reason, and then when I try to delete one of the icons both delete
- Add a selector like on windows to the desktop, so if I hold click on the desktop i can select multiple files with a selector thing like again on windows
- Fix this issue in the video/image viewer where it just says "File too large" sometimes with some files
- Add a defualt app section to the settings so you can choose your defualt web browser, file explorer, video player/image viewer, etc (the defualt options there will be the DE's built in ones, but the user can choose otherwise if they want)
- Whem im in a browser and I click on a button that opens an Open With dialouge it still opens my defualt file manager's open with window instead of Liquid Desktop's one (fixing this should also make it fix for other web browsers too)
- The widget creator has a few issues, like when i click somthing in the insert list it does insert but it dosn't appear in the text box it just inserts it, so I am unable to delete anything after its inserted.
- Add snapping to a grid and normal snapping to the widget editor (the user can select which one they want enabled) to make centering and moving object easier.
- The photo widget is WAY too big and I'm pretty sure its just using the size of the image for the size of the widget instead of being locked to the small widget size its supposed to be.
- Sometimes when closing the widget adding menu it remains for a few secconds after clicking done, and I am unable to move the widgets now for some reason by dragging them in edit mode.
- Fix some visual bugs with the weather app rewrite, like the sidebar having this wierd half opaqe backround behind it that shouldnt be there and the rain precentage in the hourly forcast being all messed up and pushed inside the icons and other text and the 7 day forcast icon and precentage being too high up (and some missing features like the 7 day forcast things not being able to drop down to show more info), read the website and look through it to find what you missed and what to add, make it still have the Liquid Glass theming and everything. https://weather.nyxdev.app
- Create a custom login screen not baised on SDDM or somthing that uses our own web baised interface like the rest of the DE to make it look like the lock screen and everything else (and allows us to add proper blur)
- Add more widgets and create a format for users to create their own widgets, and then make an app called Widget Creator that is pre-installed that allows users to make widgest with custom images, network requests, text, backrounds, etc and they can export them as a custom file format to share with others. (this also means re-making the widget UI to have diffrent catigories, including pre-installed and user created ones, and with this add some more widgets related to the apps pre-installed with the OS), and of course add a widget import button somewhere too so there is a way to import it
- Make the file open with dialouge use a custom one instead of the system defualt that is themed to look like MacOS Tahoe (and make the defualt file manager the one included too) to make the expereance more cohesive.
- Remake the weather app to be like my StormView Swift rewrite for MacOS https://github.com/StormView-Project/StormView-MacOS
- Make the dock a bit less buggy, like when you go all the way to the bottom of the screen to show the dock, it shows, and then it hides and shows again and does the same thing over and over again (only happens when autohide is turned on)
- The display and sound sliders in the control panel look super broken, like the grabber is a rounded circle but the bar itself is a square at the end

- FIx the graphics device section in the about window sometimes just showing some random device instead of your actual GPU
- Make the website button in the appstore have a backround instead of having none wich looks kinda wierd/broken
- Make the deuflat size of the terminal window larger to fix this issue where some text is cut off in the terminal (especily when updating the OS the last password prompt is hidden unless you resize the window to be 1 row larger), so claude just make the window 1 row larger on each side and that will fix the issue.
- When the system is updated make it automaticly prompt the user to log out of their session
- Adding another widget sometimes just adds the widget on top of another one, and I am unable to move widgets too on the desktop
- Make dragging apps around in the dock work a bit better
- Make the icons in the file explorer look better and not have that extra icon on them thats off-center or fix the icon so its actualy centered and the right size
- Make the defualt icons look better, especilly the settings icon
- Improve the activity monitor and make it work and function better
- Add a smart hide feature to the dock where it only hides when a window intersects it or when a window is fullscreened over it (Configurable in settings)
- Make it so you can click on the account in the settings at the top and you can configure settings about your user
- Add a screenshot tool that activates with Super+Shift+S like on windows and lets you take a screenshot of an area, window, or fullscreen and saves the screenshot to a folder and copies it to your clipboard (both configurable in settings)
- Add a proper toolbar so apps that stay open in the backround (like discord or OBS when its recording) have a toolbar thing in the topbar that you can click on and right click on to see the options it has like on KDE plasma and other DE's
- Make a proper login theme for SSDM or somthing so it looks better when logging in (Make this theme automaticly install and apply itself when this update is installed)
- The chromium/electron window borders still go in front of the content sometimes after it updates even after your fix.
- Fix the dock not hiding when a maximised window is in front of it even when that is enabled in settings
- Fix notifications not being implemented 
- Implement a QT and GTK macOS theme into the DE (https://github.com/vinceliuice/MacTahoe-gtk-theme, https://github.com/vinceliuice/MacTahoe-kde), add this option inside the theme setitngs where you can see QT (kvantum) and GTK themes and select wich one, defualt should be the 2 ones listed here

# Not that important
- Minecraft opens where half of it is hidden for some reason , don't think thats that big of a deal but look into it still (Fixes itself after moving the window) (DO LATER)
