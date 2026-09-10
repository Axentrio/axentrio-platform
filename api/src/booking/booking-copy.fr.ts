import type { BookingCopy } from './booking-copy';

export const BOOKING_COPY_FR: BookingCopy = {
  'customer.subject_confirmed': 'Confirmé : {summary}',
  'customer.subject_cancelled': 'Annulé : {summary}',
  'customer.lead_confirmed': 'Votre rendez-vous est confirmé.',
  'customer.lead_cancelled': 'Votre rendez-vous a été annulé.',
  'customer.minutes': '{n} min',
  'customer.location': 'Lieu : {location}',
  'customer.before_heading': 'Avant votre rendez-vous :',
  'customer.extra_info_heading': 'Informations complémentaires :',
  'customer.invite_attached': 'Une invitation d’agenda est jointe.',
  'customer.manage_link': 'Déplacer ou annuler ce rendez-vous',
  'customer.greeting': 'Bonjour {name},',
  'customer.appointment_heading': 'Rendez-vous',
  'customer.detail_appointment': 'Rendez-vous : {summary}',
  'customer.detail_date': 'Date : {when}',
  'customer.detail_duration': 'Durée : {n} min',
  'customer.detail_price': 'Prix : {price}',

  'customer.attachments_heading': 'Pièces jointes',
  'customer.attachments_note': 'Les fichiers suivants sont joints à cet e-mail : {names}',
  'customer.regards': 'Cordialement,',

  'customer.reminder_subject': 'Rappel : {summary}',
  'customer.reminder_lead': 'Rappel : votre rendez-vous est {when}.',
  'customer.reminder_tomorrow': 'demain',
  'customer.reminder_in_1_hour': 'dans 1 heure',
  'customer.reminder_manage_link': 'Déplacer ou annuler',

  'ics.with': 'Avec : {business}',
  'ics.duration': 'Durée : {n} min',
  'ics.price': 'Prix : {price}',
  'ics.join': 'Rejoindre la réunion : {url}',
  'ics.before': 'Avant votre rendez-vous : {text}',
  'ics.manage': 'Déplacer ou annuler : {url}',

  'owner.subject_new': 'Nouvelle réservation : {summary}',
  'owner.subject_cancelled': 'Annulé : {summary}',
  'owner.a_customer': 'Un client',
  'owner.booked': '{who} a réservé un rendez-vous.',
  'owner.cancelled': '{who} a annulé son rendez-vous.',
  'owner.where': 'Où : {location}',
  'owner.video_link_missing':
    'Aucun lien de visioconférence n’a été créé pour cette réservation. Le compte d’agenda connecté ne prend peut-être pas en charge les réunions en ligne — un compte Microsoft personnel ne peut pas héberger Teams. Reconnectez un compte professionnel ou scolaire pour ajouter des liens vidéo.',
  'owner.no_customer_email':
    'La réservation a été faite via un canal de messagerie sans adresse e-mail, donc aucune invitation ne leur a été envoyée.',
  'owner.request_subject': 'Nouvelle demande de rendez-vous : {service}',
  'owner.request_intro': 'Vous avez une nouvelle demande de rendez-vous à examiner.',
  'owner.request_preferred_time': 'Horaire souhaité : {when}',
  'owner.request_from': 'De : {who}',
  'owner.request_summary': 'Résumé : {text}',
  'owner.request_notes': 'Notes : {text}',
  'owner.original_heading': 'Message original du client :',
  'owner.request_follow_up': 'Contactez le client pour confirmer ou refuser.',
  'owner.rejected_subject': 'Modification d’agenda non appliquée : {service}',
  'owner.rejected_intro':
    'Nous n’avons pas appliqué la modification que vous avez faite dans votre agenda. L’événement est revenu à l’heure d’origine.',
  'owner.rejected_customer': 'Client : {who}',
  'owner.rejected_attempted': 'Horaire tenté : {when}',
  'owner.rejected_restored': 'Horaire rétabli : {when}',
  'owner.rejected_footer': 'Déplacez cette réservation depuis la page des réservations Axentrio.',
  'owner.reason_all_day': 'Un événement sur toute la journée n’a pas d’heure de rendez-vous.',
  'owner.reason_end_before_start': 'L’heure de fin n’est pas après l’heure de début.',
  'owner.reason_slot_unavailable':
    'Cet horaire chevauche un autre rendez-vous, ou se situe en dehors de vos heures de réservation.',
  'owner.reason_travel_conflict':
    'Cet horaire n’est pas joignable depuis les rendez-vous de part et d’autre.',
  'owner.reason_not_reschedulable': 'Cette réservation n’est plus ouverte aux modifications.',
  'owner.reason_default': 'Axentrio n’a pas pu appliquer cette modification.',
  'owner.service_fallback': 'Rendez-vous',

  'event.title': 'Réservation : {service}',
  'event.title_with_name': 'Réservation : {service} - {who}',
  'event.service': 'Service : {text}',
  'event.customer': 'Client : {name}',
  'event.email': 'E-mail : {text}',
  'event.phone': 'Téléphone : {text}',
  'event.address': 'Adresse : {text}',
  'event.duration': 'Durée : {n} min',
  'event.price': 'Prix : {price}',
  'event.booked_via': 'Réservé via : {text}',
  'event.summary': 'Résumé : {text}',
  'event.notes': 'Notes : {text}',
  'event.preparation': 'Préparation : {text}',
  'event.files': 'Fichiers : {names} - ouvrez la réservation dans Axentrio pour les consulter',
  'event.intake': 'Intake :',
  'event.reference': 'Référence : {ref}',
  'event.manage': 'Gérer : {url}',
  'event.truncated': '… (tronqué)',

  'manage.title_suffix': 'Axentrio',
  'manage.error_title': 'Lien indisponible',
  'manage.error_heading': 'Ce lien ne peut pas être utilisé',
  'manage.err_invalid_link': 'Ce lien est invalide ou a expiré.',
  'manage.err_BOOKINGS_PAUSED':
    'Cette entreprise a temporairement suspendu les modifications de réservation en ligne. Contactez-la directement pour déplacer votre rendez-vous.',
  'manage.err_CALENDAR_NOT_CONNECTED':
    'Cette entreprise ne peut pas confirmer les modifications en ligne pour le moment. Contactez-la directement pour déplacer votre rendez-vous.',
  'manage.err_CALENDAR_SYNC_DISABLED':
    'Cette entreprise ne peut pas confirmer les modifications en ligne pour le moment. Contactez-la directement pour déplacer votre rendez-vous.',
  'manage.err_REQUEST_ONLY_SERVICE':
    'Ce rendez-vous ne peut pas être déplacé en ligne. Contactez l’entreprise directement.',
  'manage.err_BOOKING_TEMPORARILY_UNAVAILABLE':
    'Nous n’avons pas pu charger les horaires disponibles pour le moment. Réessayez dans quelques minutes.',
  'manage.err_SERVICE_REQUIRED':
    'Nous n’avons pas pu charger les horaires disponibles pour ce rendez-vous. Contactez l’entreprise directement.',
  'manage.err_SLOT_UNAVAILABLE': 'Cet horaire vient d’être pris. Choisissez-en un autre.',
  'manage.err_REQUEST_OUTSIDE_WINDOW': 'Cet horaire est en dehors des heures d’ouverture. Choisissez-en un autre.',
  'manage.err_BOOKING_NOT_FOUND': 'Ce rendez-vous n’a plus pu être trouvé.',
  'manage.err_CHANGE_NOT_ALLOWED':
    'Ce rendez-vous ne peut pas être modifié en ligne. Contactez l’entreprise directement.',
  'manage.err_CHANGE_REQUEST_OPEN':
    'Vous avez déjà une demande de modification en cours pour ce rendez-vous. L’entreprise vous recontactera.',
  'manage.not_found': 'Nous n’avons pas trouvé ce rendez-vous.',
  'manage.cancelled_title': 'Rendez-vous annulé',
  'manage.cancelled_body': 'Ce rendez-vous a été annulé.',
  'manage.btn_request_reschedule': 'Demander un déplacement',
  'manage.btn_reschedule': 'Déplacer',
  'manage.btn_request_cancel': 'Demander une annulation',
  'manage.btn_cancel': 'Annuler le rendez-vous',
  'manage.not_changeable':
    'Ce rendez-vous ne peut pas être modifié en ligne. Contactez l’entreprise directement.',
  'manage.manage_title': 'Gérer le rendez-vous',
  'manage.manage_intro': 'Gérez votre rendez-vous à venir.',
  'manage.cancel_requested_title': 'Annulation demandée',
  'manage.cancel_requested_body':
    'Nous avons envoyé une demande d’annulation à l’entreprise. Votre rendez-vous n’est <strong>pas encore annulé</strong> — elle confirmera.',
  'manage.cancelled_confirmed_body':
    'Votre rendez-vous a été annulé. Une confirmation vous a été envoyée par e-mail.',
  'manage.no_longer_reschedulable': 'Ce rendez-vous ne peut plus être déplacé.',
  'manage.not_reschedulable_online':
    'Ce rendez-vous ne peut pas être déplacé en ligne. Contactez l’entreprise directement.',
  'manage.no_times': 'Aucun horaire disponible dans les 30 prochains jours. Contactez-nous directement.',
  'manage.reschedule_title': 'Déplacer le rendez-vous',
  'manage.reschedule_heading': 'Déplacer',
  'manage.pick_request': ' Choisissez un nouvel horaire à demander :',
  'manage.pick': ' Choisissez un nouvel horaire :',
  'manage.currently': ' — actuellement {when}.',
  'manage.times_shown_in': 'Horaires affichés en {timezone}.',
  'manage.requestable_intro_also': 'Ces horaires peuvent aussi être possibles',
  'manage.requestable_intro_still': 'Ces horaires peuvent encore être possibles',
  'manage.requestable_tail':
    ', mais l’entreprise doit les confirmer en raison du déplacement. Contactez-la et indiquez celui que vous souhaitez :',
  'manage.reschedule_requested_title': 'Déplacement demandé',
  'manage.reschedule_requested_body':
    'Nous avons demandé à l’entreprise de déplacer votre rendez-vous vers :',
  'manage.reschedule_not_confirmed':
    'Ceci n’est <strong>pas encore confirmé</strong>. Votre rendez-vous d’origine reste valable jusqu’à son acceptation.',
  'manage.rescheduled_title': 'Rendez-vous déplacé',
  'manage.rescheduled_body': 'Votre rendez-vous a été déplacé vers :',
  'manage.updated_invite': 'Une invitation mise à jour vous a été envoyée par e-mail.',
};
