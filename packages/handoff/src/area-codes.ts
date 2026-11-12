/**
 * US area codes by the time zone most of their numbers are in, for
 * `hours.customer_time_zone` = "phone_area_code" (quiet hours in the customer's own time).
 *
 * A number keeps its area code when its owner moves, and a few area codes span two zones
 * (Florida's 850 and 448, Nebraska's 308, Indiana's 812, Idaho's 208, Kansas's 620, Oregon's
 * 541, Tennessee's 423, the Dakotas): those are listed under the zone of most of their
 * numbers. Toll-free, Canadian and Caribbean codes are not listed, so they fall back to the
 * business's zone. Compiled from the North American Numbering Plan's assignments by state.
 */
const ZONES: Readonly<Record<string, string>> = {
  "America/New_York": `
    201 202 203 207 212 215 216 220 223 227 229 231 234 239 240 248 252 260 267 269 272 276
    283 301 302 304 305 313 315 317 321 324 326 330 332 336 339 347 351 352 363 380 386 401 404
    407 410 412 413 419 423 434 436 440 443 445 463 470 472 475 478 484 502 508
    513 516 517 518 540 551 561 567 570 571 574 582 585 586 603 606 607 609 610 614 616 617
    624 631 640 645 646 656 667 678 679 680 681 686 689 703 704 706 716 717 718 724
    727 728 732 734 740 743 754 757 762 765 770 771 772 774 781 786 802 803 804 810 812 813
    814 826 828 835 838 839 843 845 848 854 856 857 859 860 862 863 864 865 878 904 906 908
    910 912 914 917 919 929 930 934 937 941 943 947 948 954 959 973 978 980 984 989`,
  "America/Chicago": `
    205 210 214 217 218 219 224 225 228 251 254 256 262 270 274 281 309 312 314 316 318 319
    308 320 325 327 331 334 337 346 353 361 364 402 405 409 414 417 430 432 447 448 464 469
    479 483 501 504
    507 512 515 531 534 539 557 563 572 573 580 601 605 608 612 615 618 620 629 630 636 641
    651 659 660 662 682 701 708 712 713 715 726 730 731 737 763 769 773 779 785 806 815 816
    817 830 832 847 850 861 870 872 901 903 913 918 920 924 931 936 938 940 945 952 956 972 975
    979 985`,
  "America/Denver": "303 307 385 406 435 505 575 719 720 801 915 970 983",
  "America/Boise": "208 986",
  "America/Phoenix": "480 520 602 623 928",
  "America/Los_Angeles": `
    206 209 213 253 279 310 323 341 350 360 369 408 415 424 425 442 458 503 509 510 530 541
    559 562 564 619 626 628 650 657 661 669 702 707 714 725 747 760 775 805 818 820 831 840
    858 909 916 925 949 951 971`,
  "America/Anchorage": "907",
  "Pacific/Honolulu": "808",
  "America/Puerto_Rico": "340 787 939",
  "Pacific/Guam": "670 671",
};

const BY_AREA_CODE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [zone, codes] of Object.entries(ZONES)) {
    for (const code of codes.split(/\s+/)) {
      if (/^\d{3}$/.test(code)) map.set(code, zone);
    }
  }
  return map;
})();

/** The time zone of a US number in E.164 (`+1AAANNNNNNN`), or null when unknown. */
export function timeZoneOfPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const match = /^\+1(\d{3})\d{7}$/.exec(phone.replace(/[\s().-]/g, ""));
  if (match === null) return null;
  return BY_AREA_CODE.get(match[1]!) ?? null;
}
